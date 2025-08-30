require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 9899;

// Supabase 설정
const supabaseUrl = process.env.SUPABASE_URL || 'your-supabase-url';
const supabaseKey = process.env.SUPABASE_KEY || 'your-supabase-anon-key';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.warn('⚠️  Supabase 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// HTTPS 리다이렉트 미들웨어 (프로덕션 환경에서)
app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https' && process.env.NODE_ENV === 'production') {
        res.redirect(`https://${req.header('host')}${req.url}`);
    } else {
        next();
    }
});

// 미들웨어 설정
app.use(cors({
    origin: '*', // 모든 도메인에서 접근 허용
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges'],
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));
// 기본 정적 파일 제공
app.use('/uploads', express.static('uploads'));

// 오디오 파일 전용 라우트 (Range 요청 지원)
app.get('/audio/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'uploads', filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }
    
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    // Range 요청 지원 (오디오 스트리밍)
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'audio/mpeg',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Range',
            'Cache-Control': 'no-cache'
        };
        
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'audio/mpeg',
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache'
        };
        
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
    }
});

// 업로드 디렉토리 생성
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// yt-dlp 설치 확인 함수
function checkYtDlp() {
    return new Promise((resolve) => {
        exec('yt-dlp --version', (error) => {
            resolve(!error);
        });
    });
}

// 시간 형식 검증 함수 (서버측)
function isValidTimeFormat(time) {
    if (!time || typeof time !== 'string') return false;
    
    // HH:MM:SS 형식만 허용 (정규화된 형식)
    const pattern = /^([0-9]|[0-1][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])$/;
    const match = time.match(pattern);
    
    if (match) {
        const [, hours, minutes, seconds] = match;
        return parseInt(hours) <= 23 && 
               parseInt(minutes) <= 59 && 
               parseInt(seconds) <= 59;
    }
    
    return false;
}

// 시간을 초 단위로 변환
function timeToSeconds(timeStr) {
    const parts = timeStr.split(':').map(num => parseInt(num));
    if (parts.length === 3) {
        const [hours, minutes, seconds] = parts;
        return hours * 3600 + minutes * 60 + seconds;
    }
    return 0;
}

// 초를 시간 형식으로 변환
function secondsToTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// MP3 추출 공통 함수
async function handleMp3Extraction(req, res, { youtubeUrl, startTime, endTime, title }) {
    const jobId = Date.now().toString();
    
    try {
        // 시간 형식 검증
        if (!isValidTimeFormat(startTime) || !isValidTimeFormat(endTime)) {
            return res.status(400).json({ 
                error: '시간 형식이 올바르지 않습니다. HH:MM:SS 형식을 사용해주세요.' 
            });
        }

        // yt-dlp 설치 확인
        const isYtDlpInstalled = await checkYtDlp();
        if (!isYtDlpInstalled) {
            return res.status(500).json({ 
                error: 'yt-dlp가 설치되지 않았습니다. pip install yt-dlp 명령으로 설치해주세요.' 
            });
        }

        // 파일명에서 특수문자 제거
        const sanitizedTitle = (title || 'sermon').replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);
        const fileName = `${Date.now()}_${sanitizedTitle}.mp3`;
        const outputPath = path.join(uploadDir, fileName);
        const tempFile = path.join(uploadDir, `temp_${Date.now()}.mp3`);

        console.log(`다운로드 시작: ${youtubeUrl} (Job ID: ${jobId})`);
        console.log(`임시 파일: ${tempFile}`);
        console.log(`최종 파일: ${outputPath}`);

        // 진행상황 초기화
        broadcastProgress(jobId, {
            type: 'started',
            stage: 'initializing',
            message: '다운로드 준비 중...',
            progress: 0
        });

        // 즉시 jobId 응답
        res.json({
            success: true,
            jobId: jobId,
            message: '다운로드가 시작되었습니다. 진행상황을 확인하세요.',
            progressUrl: `/api/progress/${jobId}`
        });

        // 단계별 실행: yt-dlp --download-sections 옵션으로 구간 직접 다운로드
        const sectionRange = `*${startTime}-${endTime}`;
        console.log(`다운로드 구간: ${sectionRange}`);
        
        broadcastProgress(jobId, {
            type: 'progress',
            stage: 'downloading',
            message: '구간 다운로드 중...',
            progress: 10
        });
        
        // spawn을 사용하여 버퍼 오버플로우 방지
        const args = [
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '--download-sections', sectionRange,
            '--progress',
            '--newline',
            '-o', outputPath,
            youtubeUrl
        ];
        
        console.log('yt-dlp 명령어:', 'yt-dlp', args.join(' '));
        
        const childProcess = spawn('yt-dlp', args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let downloadProgress = 10;
        let outputBuffer = '';
        let errorBuffer = '';
        
        // stdout 처리 (진행상황 파싱)
        childProcess.stdout.on('data', (data) => {
            const output = data.toString();
            outputBuffer += output;
            console.log('yt-dlp stdout:', output);
            
            // 다운로드 진행률 파싱
            const progressMatch = output.match(/(\d+\.\d+)%/);
            if (progressMatch) {
                const percent = parseFloat(progressMatch[1]);
                downloadProgress = Math.min(10 + (percent * 0.7), 80); // 10-80% 범위로 매핑
                
                broadcastProgress(jobId, {
                    type: 'progress',
                    stage: 'downloading',
                    message: `다운로드 중... ${percent.toFixed(1)}%`,
                    progress: Math.round(downloadProgress)
                });
            }
            
            // 변환 시작 감지
            if (output.includes('[ExtractAudio]')) {
                broadcastProgress(jobId, {
                    type: 'progress',
                    stage: 'converting',
                    message: '오디오 변환 중...',
                    progress: 85
                });
            }
        });
        
        // stderr 처리
        childProcess.stderr.on('data', (data) => {
            const error = data.toString();
            errorBuffer += error;
            console.log('yt-dlp stderr:', error);
        });
        
        // 프로세스 완료 처리
        childProcess.on('close', (code) => {
            console.log(`yt-dlp 프로세스 종료 코드: ${code}`);
            console.log('전체 출력:', outputBuffer);
            if (errorBuffer) console.log('전체 에러:', errorBuffer);
            
            if (code !== 0) {
                console.error('Download Error: 프로세스가 비정상 종료됨');
                broadcastProgress(jobId, {
                    type: 'error',
                    stage: 'failed',
                    message: `다운로드 오류: 프로세스 종료 코드 ${code}`,
                    error: errorBuffer || `프로세스 종료 코드: ${code}`
                });
                return;
            }

            broadcastProgress(jobId, {
                type: 'progress',
                stage: 'processing',
                message: '파일 처리 중...',
                progress: 90
            });

            // 최종 파일이 생성되었는지 확인
            if (!fs.existsSync(outputPath)) {
                console.error('최종 파일이 생성되지 않았습니다:', outputPath);
                broadcastProgress(jobId, {
                    type: 'error',
                    stage: 'failed',
                    message: 'MP3 파일 생성에 실패했습니다.',
                    error: 'File generation failed'
                });
                return;
            }

            const finalFileSize = fs.statSync(outputPath).size;
            console.log(`최종 파일 크기: ${finalFileSize} bytes`);

            // 동적 호스트 및 프로토콜 감지 (HTTPS 우선)
            const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' || req.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'https'; // 기본적으로 HTTPS 사용
            const host = req.get('host');
            
            // 완료 알림
            broadcastProgress(jobId, {
                type: 'completed',
                stage: 'finished',
                message: 'MP3 구간 다운로드가 완료되었습니다!',
                progress: 100,
                fileName: fileName,
                filePath: `/uploads/${fileName}`,
                downloadUrl: `${protocol}://${host}/uploads/${fileName}`,
                fileSize: finalFileSize
            });

            // 5초 후 진행상황 추적 정리
            setTimeout(() => {
                progressTrackers.delete(jobId);
            }, 5000);
        });
        
        // 프로세스 에러 처리
        childProcess.on('error', (error) => {
            console.error('spawn 에러:', error);
            broadcastProgress(jobId, {
                type: 'error',
                stage: 'failed',
                message: `프로세스 시작 오류: ${error.message}`,
                error: error.message
            });
        });

    } catch (error) {
        console.error('Error:', error);
        broadcastProgress(jobId, {
            type: 'error',
            stage: 'failed',
            message: '서버 오류가 발생했습니다.',
            error: error.message
        });
        if (!res.headersSent) {
            res.status(500).json({ error: '서버 오류가 발생했습니다.' });
        }
    }
}

// YouTube에서 MP3 추출 API (기존)
app.post('/api/extract-mp3', async (req, res) => {
    const { youtubeUrl, startTime, endTime, title } = req.body;
    
    if (!youtubeUrl || !startTime || !endTime) {
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }

    return handleMp3Extraction(req, res, { youtubeUrl, startTime, endTime, title });
});

// 설교 목록 조회 API
app.get('/api/sermons', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const offset = (page - 1) * limit;

        const { data: sermons, error } = await supabase
            .from('serm')
            .select('*')
            .order('date', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        // 전체 개수 조회
        const { count } = await supabase
            .from('serm')
            .select('*', { count: 'exact', head: true });

        res.json({
            sermons,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(count / limit),
                totalItems: count,
                itemsPerPage: limit
            }
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '설교 목록 조회 중 오류가 발생했습니다.' });
    }
});

// 설교 생성 API
app.post('/api/sermons', async (req, res) => {
    try {
        const { title, date, mp3File, txtFile } = req.body;

        if (!title || !date || !mp3File || !txtFile) {
            return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
        }

        const { data, error } = await supabase
            .from('serm')
            .insert([{
                title,
                date,
                mp3_file: mp3File,
                txt_file: txtFile
            }])
            .select();

        if (error) throw error;

        res.json({ success: true, sermon: data[0] });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '설교 생성 중 오류가 발생했습니다.' });
    }
});

// 설교 수정 API
app.put('/api/sermons/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { title, date, mp3File, txtFile } = req.body;

        const { data, error } = await supabase
            .from('serm')
            .update({
                title,
                date,
                mp3_file: mp3File,
                txt_file: txtFile
            })
            .eq('id', id)
            .select();

        if (error) throw error;

        res.json({ success: true, sermon: data[0] });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '설교 수정 중 오류가 발생했습니다.' });
    }
});

// 설교 삭제 API
app.delete('/api/sermons/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabase
            .from('serm')
            .delete()
            .eq('id', id);

        if (error) throw error;

        res.json({ success: true, message: '설교가 삭제되었습니다.' });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '설교 삭제 중 오류가 발생했습니다.' });
    }
});

// 설교 상세 조회 API
app.get('/api/sermons/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const { data, error } = await supabase
            .from('serm')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw error;

        res.json({ sermon: data });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '설교 조회 중 오류가 발생했습니다.' });
    }
});

// 외부 API - 간단한 MP3 추출 (GET 요청 지원)
app.get('/api/convert', async (req, res) => {
    try {
        const { url, start, end, title } = req.query;
        
        if (!url || !start || !end) {
            return res.status(400).json({ 
                error: '필수 파라미터가 누락되었습니다.',
                required: 'url, start, end',
                example: '/api/convert?url=https://youtu.be/VIDEO_ID&start=0:30:00&end=1:00:00&title=sermon_title'
            });
        }

        // 내부 extract-mp3 API 호출
        return handleMp3Extraction(req, res, {
            youtubeUrl: url,
            startTime: start,
            endTime: end,
            title: title || 'converted_audio'
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 외부 API - POST 요청으로도 지원
app.post('/api/convert', async (req, res) => {
    try {
        const { url, start, end, title } = req.body;
        
        if (!url || !start || !end) {
            return res.status(400).json({ 
                error: '필수 파라미터가 누락되었습니다.',
                required: 'url, start, end',
                example: '{"url": "https://youtu.be/VIDEO_ID", "start": "0:30:00", "end": "1:00:00", "title": "sermon_title"}'
            });
        }

        return handleMp3Extraction(req, res, {
            youtubeUrl: url,
            startTime: start,
            endTime: end,
            title: title || 'converted_audio'
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// API 문서 엔드포인트
app.get('/api/docs', (req, res) => {
    res.json({
        title: 'YouTube MP3 변환 API',
        description: 'YouTube 비디오에서 지정된 구간의 MP3를 추출합니다.',
        baseUrl: `http://localhost:${PORT}`,
        endpoints: {
            convert_get: {
                method: 'GET',
                url: '/api/convert',
                description: 'GET 요청으로 MP3 변환',
                parameters: {
                    url: 'YouTube 비디오 URL (필수)',
                    start: '시작 시간 (HH:MM:SS 형식, 필수)',
                    end: '종료 시간 (HH:MM:SS 형식, 필수)',
                    title: '파일 제목 (선택)'
                },
                example: '/api/convert?url=https://youtu.be/VIDEO_ID&start=0:30:00&end=1:00:00&title=my_audio'
            },
            convert_post: {
                method: 'POST',
                url: '/api/convert',
                description: 'POST 요청으로 MP3 변환',
                contentType: 'application/json',
                body: {
                    url: 'YouTube 비디오 URL (필수)',
                    start: '시작 시간 (HH:MM:SS 형식, 필수)',
                    end: '종료 시간 (HH:MM:SS 형식, 필수)',
                    title: '파일 제목 (선택)'
                },
                example: {
                    url: 'https://youtu.be/VIDEO_ID',
                    start: '0:30:00',
                    end: '1:00:00',
                    title: 'my_audio'
                }
            }
        },
        response: {
            success: {
                success: true,
                fileName: '생성된 파일명',
                filePath: '서버 내 파일 경로',
                downloadUrl: '다운로드 URL',
                message: '완료 메시지',
                fileSize: '파일 크기 (bytes)'
            },
            error: {
                error: '오류 메시지'
            }
        },
        notes: [
            'yt-dlp와 ffmpeg가 설치되어 있어야 합니다.',
            '시간 형식은 HH:MM:SS (예: 1:30:45) 또는 MM:SS (예: 30:45)입니다.',
            '생성된 MP3 파일은 /uploads/{fileName} 경로에서 다운로드할 수 있습니다.'
        ]
    });
});

// 간단한 상태 확인 엔드포인트
app.get('/api/status', async (req, res) => {
    const ytDlpInstalled = await checkYtDlp();
    res.json({
        server: 'running',
        port: PORT,
        ytdlp_installed: ytDlpInstalled,
        endpoints: [
            'GET /api/convert',
            'POST /api/convert', 
            'GET /api/docs',
            'GET /api/status',
            'GET /api/files',
            'GET /api/progress/:jobId'
        ]
    });
});

// Server-Sent Events를 위한 진행상황 추적
const progressTrackers = new Map();

// 진행상황 SSE 엔드포인트
app.get('/api/progress/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // 클라이언트에게 연결 확인
    res.write(`data: ${JSON.stringify({ type: 'connected', jobId })}\n\n`);

    // 진행상황 추적에 추가
    if (!progressTrackers.has(jobId)) {
        progressTrackers.set(jobId, []);
    }
    progressTrackers.get(jobId).push(res);

    // 클라이언트 연결 해제 시 정리
    req.on('close', () => {
        if (progressTrackers.has(jobId)) {
            const connections = progressTrackers.get(jobId);
            const index = connections.indexOf(res);
            if (index > -1) {
                connections.splice(index, 1);
            }
            if (connections.length === 0) {
                progressTrackers.delete(jobId);
            }
        }
    });
});

// 진행상황 브로드캐스트 함수
function broadcastProgress(jobId, data) {
    if (progressTrackers.has(jobId)) {
        const connections = progressTrackers.get(jobId);
        const message = `data: ${JSON.stringify(data)}\n\n`;
        
        connections.forEach((res, index) => {
            try {
                res.write(message);
            } catch (error) {
                console.error('SSE 전송 오류:', error);
                connections.splice(index, 1);
            }
        });
    }
}

// 업로드된 파일 목록 조회 API
app.get('/api/files', (req, res) => {
    try {
        const files = fs.readdirSync(uploadDir)
            .filter(file => file.endsWith('.mp3'))
            .map(file => {
                const filePath = path.join(uploadDir, file);
                const stats = fs.statSync(filePath);
                const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' || req.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'https'; // 기본적으로 HTTPS 사용
                const host = req.get('host');
                
                return {
                    fileName: file,
                    downloadUrl: `${protocol}://${host}/uploads/${file}`,
                    fileSize: stats.size,
                    createdAt: stats.birthtime,
                    modifiedAt: stats.mtime
                };
            })
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // 최신순 정렬

        res.json({
            success: true,
            files: files,
            count: files.length
        });
    } catch (error) {
        console.error('Error reading files:', error);
        res.status(500).json({ error: '파일 목록을 읽는 중 오류가 발생했습니다.' });
    }
});

// Supabase 연결 테스트
async function testSupabaseConnection() {
    try {
        const { data, error } = await supabase.from('serm').select('count', { count: 'exact', head: true });
        if (error) {
            console.error('Supabase 연결 오류:', error.message);
            return false;
        }
        console.log('Supabase 연결 성공');
        return true;
    } catch (error) {
        console.error('Supabase 연결 테스트 실패:', error.message);
        return false;
    }
}

app.listen(PORT, async () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    
    // Supabase 연결 테스트
    const isConnected = await testSupabaseConnection();
    if (!isConnected) {
        console.log('⚠️  Supabase 연결에 문제가 있습니다. 설교 관리 기능이 제한될 수 있습니다.');
    }
    
    console.log('웹 브라우저에서 http://localhost:9899 로 접속하세요.');
}); 
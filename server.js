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
const { Client } = require('basic-ftp');

const app = express();
const PORT = process.env.PORT || 9899;

// Supabase 설정
const supabaseUrl = process.env.SUPABASE_URL || 'your-supabase-url';
const supabaseKey = process.env.SUPABASE_KEY || 'your-supabase-anon-key';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.warn('⚠️  Supabase 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// FTP 설정
const ftpConfig = {
    host: process.env.FTP_HOST,
    user: process.env.FTP_USER,
    password: process.env.FTP_PASS,
    port: process.env.FTP_PORT ? parseInt(process.env.FTP_PORT) : 21,
    secure: false // true for FTPS
};

// 백그라운드 작업 큐
const backgroundJobs = new Map();

// FTP 업로드 함수
async function uploadToFTP(localFilePath, remoteFileName) {
    if (!ftpConfig.host || !ftpConfig.user || !ftpConfig.password) {
        console.log('FTP 설정이 없어서 업로드를 건너뜁니다.');
        return null;
    }
    
    const client = new Client();
    try {
        await client.access(ftpConfig);
        console.log('FTP 연결 성공');
        
        const remotePath = path.posix.join(process.env.FTP_PATH || '/sermon/', remoteFileName);
        await client.uploadFrom(localFilePath, remotePath);
        console.log(`FTP 업로드 완료: ${remotePath}`);
        
        const ftpUrl = `https://${ftpConfig.host}${remotePath}`;
        return ftpUrl;
    } catch (error) {
        console.error('FTP 업로드 오류:', error);
        return null;
    } finally {
        client.close();
    }
}

// YouTube 제목 추출 함수 (한글 인코딩 지원)
async function getYouTubeTitle(youtubeUrl) {
    return new Promise((resolve) => {
        const ytProcess = spawn('yt-dlp', ['--get-title', '--encoding', 'utf-8', youtubeUrl], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        
        let title = '';
        ytProcess.stdout.on('data', (data) => {
            try {
                // UTF-8로 디코딩
                title += data.toString('utf8').trim();
            } catch (error) {
                console.error('제목 디코딩 오류:', error);
                title += data.toString().trim();
            }
        });
        
        ytProcess.on('close', (code) => {
            if (code === 0 && title) {
                console.log('원본 YouTube 제목:', title);
                
                // 한글과 영문만 허용, 특수문자 제거
                let cleanTitle = title
                    .replace(/[<>:"/\\|?*]/g, '_')  // 파일명 금지 문자
                    .replace(/[^\w\s가-힣ㄱ-ㅎㅏ-ㅣ]/g, '_')  // 한글, 영문, 숫자, 공백만 허용
                    .replace(/\s+/g, '_')  // 공백을 언더스코어로
                    .replace(/_+/g, '_')   // 연속된 언더스코어 정리
                    .substring(0, 50);     // 길이 제한
                
                // 앞뒤 언더스코어 제거
                cleanTitle = cleanTitle.replace(/^_+|_+$/g, '');
                
                // 빈 문자열이면 기본값 사용
                if (!cleanTitle || cleanTitle.length === 0) {
                    cleanTitle = 'youtube_video';
                }
                
                console.log('정리된 제목:', cleanTitle);
                resolve(cleanTitle);
            } else {
                resolve('youtube_video');
            }
        });
        
        ytProcess.on('error', (error) => {
            console.error('yt-dlp 제목 추출 오류:', error);
            resolve('youtube_video');
        });
    });
}

// Supabase에 설교 정보 자동 저장
async function saveToSupabase(fileName, title, mp3Url, duration) {
    try {
        if (supabaseUrl === 'your-supabase-url' || supabaseKey === 'your-supabase-anon-key') {
            console.log('Supabase 설정이 없어서 저장을 건너뜁니다.');
            return;
        }
        
        const { data, error } = await supabase
            .from('serm')
            .insert([{
                title: title || fileName,
                date: new Date().toISOString().split('T')[0],
                mp3_file: mp3Url,
                txt_file: '', // 필요시 음성인식 텍스트 파일 URL
                created_at: new Date().toISOString()
            }]);
            
        if (error) {
            console.error('Supabase 저장 오류:', error);
        } else {
            console.log('Supabase 저장 완료:', title);
        }
    } catch (error) {
        console.error('Supabase 저장 중 오류:', error);
    }
}

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

// MP3 추출 공통 함수 (개선된 버전)
async function handleMp3Extraction(req, res, { youtubeUrl, startTime, endTime, title }) {
    const jobId = Date.now().toString();
    
    try {
        // 전체 비디오 처리인지 확인 (시간이 빈 값인 경우)
        const isFullVideo = !startTime || !endTime || startTime.trim() === '' || endTime.trim() === '';
        
        // 시간 형식 검증 (전체 비디오가 아닌 경우에만)
        if (!isFullVideo && (!isValidTimeFormat(startTime) || !isValidTimeFormat(endTime))) {
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

        // YouTube 제목 자동 추출 (제목이 빈 경우)
        let finalTitle = title;
        if (!title || title.trim() === '') {
            console.log('제목이 비어있어서 YouTube 제목을 추출합니다...');
            finalTitle = await getYouTubeTitle(youtubeUrl);
            console.log(`추출된 YouTube 제목: ${finalTitle}`);
        }

        // 파일명에서 특수문자 제거
        const sanitizedTitle = (finalTitle || 'sermon').replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);
        const fileName = `${Date.now()}_${sanitizedTitle}.mp3`;
        const outputPath = path.join(uploadDir, fileName);

        console.log(`다운로드 시작: ${youtubeUrl} (Job ID: ${jobId})`);
        console.log(`전체 비디오: ${isFullVideo}`);
        console.log(`최종 파일: ${outputPath}`);

        // 진행상황 초기화
        broadcastProgress(jobId, {
            type: 'started',
            stage: 'initializing',
            message: '다운로드 준비 중...',
            progress: 0
        });

        // 즉시 jobId 응답 - 창을 닫아도 계속 처리됨
        res.json({
            success: true,
            jobId: jobId,
            message: '다운로드가 백그라운드에서 시작되었습니다. 창을 닫아도 계속 처리됩니다.',
            progressUrl: `/api/progress/${jobId}`,
            fileName: fileName
        });

        // 백그라운드 작업으로 등록
        backgroundJobs.set(jobId, {
            status: 'processing',
            fileName: fileName,
            title: finalTitle,
            startTime: new Date()
        });

        // 백그라운드에서 비동기 처리 시작
        processMP3InBackground(jobId, youtubeUrl, startTime, endTime, isFullVideo, outputPath, fileName, finalTitle);

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

// 백그라운드 MP3 처리 함수
async function processMP3InBackground(jobId, youtubeUrl, startTime, endTime, isFullVideo, outputPath, fileName, finalTitle) {
    try {
        console.log(`백그라운드 처리 시작: ${jobId}`);
        
        // yt-dlp 명령어 구성
        let args = [
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '--progress',
            '--newline',
            '-o', outputPath
        ];

        // 구간 지정 또는 전체 비디오
        if (!isFullVideo) {
            const sectionRange = `*${startTime}-${endTime}`;
            args.push('--download-sections', sectionRange);
            console.log(`다운로드 구간: ${sectionRange}`);
        } else {
            console.log('전체 비디오 다운로드');
        }
        
        args.push(youtubeUrl);
        
        broadcastProgress(jobId, {
            type: 'progress',
            stage: 'downloading',
            message: isFullVideo ? '전체 영상 다운로드 중...' : '구간 다운로드 중...',
            progress: 10
        });
        
        console.log('yt-dlp 명령어:', 'yt-dlp', args.join(' '));
        
        const childProcess = spawn('yt-dlp', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
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
        childProcess.on('close', async (code) => {
            console.log(`yt-dlp 프로세스 종료 코드: ${code}`);
            
            if (code !== 0) {
                console.error('Download Error: 프로세스가 비정상 종료됨');
                broadcastProgress(jobId, {
                    type: 'error',
                    stage: 'failed',
                    message: `다운로드 오류: 프로세스 종료 코드 ${code}`,
                    error: errorBuffer || `프로세스 종료 코드: ${code}`
                });
                backgroundJobs.delete(jobId);
                return;
            }

            // 파일 존재 확인
            if (!fs.existsSync(outputPath)) {
                console.error('최종 파일이 생성되지 않았습니다:', outputPath);
                broadcastProgress(jobId, {
                    type: 'error',
                    stage: 'failed',
                    message: 'MP3 파일 생성에 실패했습니다.',
                    error: 'File generation failed'
                });
                backgroundJobs.delete(jobId);
                return;
            }

            const finalFileSize = fs.statSync(outputPath).size;
            console.log(`최종 파일 크기: ${finalFileSize} bytes`);

            // FTP 업로드 진행
            broadcastProgress(jobId, {
                type: 'progress',
                stage: 'uploading',
                message: 'FTP 업로드 중...',
                progress: 90
            });

            const ftpUrl = await uploadToFTP(outputPath, fileName);
            const finalUrl = ftpUrl || `/uploads/${fileName}`;

            // Supabase 저장
            broadcastProgress(jobId, {
                type: 'progress',
                stage: 'saving',
                message: 'DB 저장 중...',
                progress: 95
            });

            await saveToSupabase(fileName, finalTitle, finalUrl);

            // 완료 알림
            broadcastProgress(jobId, {
                type: 'completed',
                stage: 'finished',
                message: 'MP3 추출 및 업로드가 완료되었습니다!',
                progress: 100,
                fileName: fileName,
                filePath: `/uploads/${fileName}`,
                downloadUrl: finalUrl,
                fileSize: finalFileSize,
                ftpUploaded: !!ftpUrl,
                supabaseSaved: true
            });

            // 백그라운드 작업 완료 표시
            backgroundJobs.set(jobId, {
                ...backgroundJobs.get(jobId),
                status: 'completed',
                endTime: new Date(),
                downloadUrl: finalUrl
            });

            // 5분 후 진행상황 추적 정리
            setTimeout(() => {
                progressTrackers.delete(jobId);
                backgroundJobs.delete(jobId);
            }, 300000); // 5분
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
            backgroundJobs.delete(jobId);
        });

    } catch (error) {
        console.error('백그라운드 처리 오류:', error);
        broadcastProgress(jobId, {
            type: 'error',
            stage: 'failed',
            message: '백그라운드 처리 중 오류가 발생했습니다.',
            error: error.message
        });
        backgroundJobs.delete(jobId);
    }
}


// YouTube에서 MP3 추출 API (개선된 버전)
app.post('/api/extract-mp3', async (req, res) => {
    const { youtubeUrl, startTime, endTime, title } = req.body;
    
    // YouTube URL은 필수, 시간과 제목은 선택사항
    if (!youtubeUrl) {
        return res.status(400).json({ error: 'YouTube URL이 필요합니다.' });
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

// 외부 API - 간단한 MP3 추출 (GET 요청 지원) - 개선된 버전
app.get('/api/convert', async (req, res) => {
    try {
        const { url, start, end, title } = req.query;
        
        // URL만 필수, 나머지는 선택사항
        if (!url) {
            return res.status(400).json({ 
                error: 'YouTube URL이 필요합니다.',
                required: 'url',
                example: '/api/convert?url=https://youtu.be/VIDEO_ID&start=0:30:00&end=1:00:00&title=sermon_title',
                note: 'start, end, title은 선택사항입니다. 빈 값이면 전체 영상을 추출하고 YouTube 제목을 사용합니다.'
            });
        }

        // 내부 extract-mp3 API 호출
        return handleMp3Extraction(req, res, {
            youtubeUrl: url,
            startTime: start,
            endTime: end,
            title: title
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 외부 API - POST 요청으로도 지원 - 개선된 버전
app.post('/api/convert', async (req, res) => {
    try {
        const { url, start, end, title } = req.body;
        
        // URL만 필수, 나머지는 선택사항
        if (!url) {
            return res.status(400).json({ 
                error: 'YouTube URL이 필요합니다.',
                required: 'url',
                example: '{"url": "https://youtu.be/VIDEO_ID", "start": "0:30:00", "end": "1:00:00", "title": "sermon_title"}',
                note: 'start, end, title은 선택사항입니다. 빈 값이면 전체 영상을 추출하고 YouTube 제목을 사용합니다.'
            });
        }

        return handleMp3Extraction(req, res, {
            youtubeUrl: url,
            startTime: start,
            endTime: end,
            title: title
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

// 백그라운드 작업 상태 조회 API
app.get('/api/background-jobs', (req, res) => {
    const jobs = Array.from(backgroundJobs.entries()).map(([jobId, job]) => ({
        jobId,
        ...job,
        duration: job.endTime ? 
            Math.round((job.endTime - job.startTime) / 1000) : 
            Math.round((new Date() - job.startTime) / 1000)
    }));
    
    res.json({
        success: true,
        jobs: jobs,
        total: jobs.length,
        processing: jobs.filter(j => j.status === 'processing').length,
        completed: jobs.filter(j => j.status === 'completed').length
    });
});

// 간단한 상태 확인 엔드포인트
app.get('/api/status', async (req, res) => {
    const ytDlpInstalled = await checkYtDlp();
    const backgroundJobsCount = backgroundJobs.size;
    
    res.json({
        server: 'running',
        port: PORT,
        ytdlp_installed: ytDlpInstalled,
        background_jobs: backgroundJobsCount,
        features: {
            background_processing: true,
            ftp_upload: !!process.env.FTP_HOST,
            supabase_integration: !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY),
            youtube_title_extraction: true,
            full_video_download: true
        },
        endpoints: [
            'GET /api/convert (개선됨)',
            'POST /api/convert (개선됨)', 
            'GET /api/docs',
            'GET /api/status',
            'GET /api/files',
            'GET /api/background-jobs (새로움)',
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
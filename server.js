require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { exec, execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
const { Translate } = require('@google-cloud/translate').v2;
const axios = require('axios');
const { google } = require('googleapis');
const { marked } = require('marked');
const multerUpload = multer({
    dest: 'uploads/temp/',
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('비디오 파일만 업로드 가능합니다.'));
        }
    }
});

// ==================== Process-Level Crash Protection ====================
process.on('uncaughtException', (err) => {
    console.error(`[FATAL] uncaughtException: ${err.message}`, err.stack);
    // 프로세스를 종료하지 않고 로깅만 수행 (PM2가 재시작 담당)
});
process.on('unhandledRejection', (reason, promise) => {
    console.error(`[FATAL] unhandledRejection:`, reason);
});

// ==================== Configuration ====================
const CONFIG = {
    // Server
    PORT: parseInt(process.env.PORT) || 9897,
    // Timeouts (ms)
    FFMPEG_TIMEOUT: parseInt(process.env.FFMPEG_TIMEOUT) || 10 * 60 * 1000,
    YTDLP_TIMEOUT: parseInt(process.env.YTDLP_TIMEOUT) || 30 * 60 * 1000,
    SSE_TIMEOUT: parseInt(process.env.SSE_TIMEOUT) || 10 * 60 * 1000,
    AI_API_TIMEOUT: parseInt(process.env.AI_API_TIMEOUT) || 120000,
    SSE_HEARTBEAT_INTERVAL: parseInt(process.env.SSE_HEARTBEAT_INTERVAL) || 30000,
    // Job limits
    MAX_CONCURRENT_JOBS: parseInt(process.env.MAX_CONCURRENT_JOBS) || 2,
    MAX_CONCURRENT_SIEUN: parseInt(process.env.MAX_CONCURRENT_SIEUN) || 2,
    MAX_JOBS: parseInt(process.env.MAX_JOBS) || 100,
    MAX_SSE_PER_JOB: parseInt(process.env.MAX_SSE_PER_JOB) || 5,
    JOB_CLEANUP_DELAY: parseInt(process.env.JOB_CLEANUP_DELAY) || 5 * 60 * 1000,
    // Upload
    MAX_UPLOAD_SIZE: parseInt(process.env.MAX_UPLOAD_SIZE) || 500 * 1024 * 1024,
    // Logging
    LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),
    // Telegram 완료 알림 (둘 다 set이면 활성)
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    // YouTube 자동 업로드 (모두 set이면 활성)
    YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID || '',
    YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET || '',
    YOUTUBE_REFRESH_TOKEN: process.env.YOUTUBE_REFRESH_TOKEN || '',
    YOUTUBE_PRIVACY_STATUS: process.env.YOUTUBE_PRIVACY_STATUS || 'unlisted',
};

// ==================== Structured Logging ====================
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const log = {
    _shouldLog(level) { return LOG_LEVELS[level] <= LOG_LEVELS[CONFIG.LOG_LEVEL]; },
    _format(level, tag, msg) {
        return `[${new Date().toISOString()}] [${level.toUpperCase()}] [${tag}] ${msg}`;
    },
    error(tag, msg, ...args) { if (this._shouldLog('error')) console.error(this._format('error', tag, msg), ...args); },
    warn(tag, msg, ...args) { if (this._shouldLog('warn')) console.warn(this._format('warn', tag, msg), ...args); },
    info(tag, msg, ...args) { if (this._shouldLog('info')) console.log(this._format('info', tag, msg), ...args); },
    debug(tag, msg, ...args) { if (this._shouldLog('debug')) console.log(this._format('debug', tag, msg), ...args); },
};

// ==================== Telegram Notification ====================
function escapeTelegramHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function notifyTelegram(text) {
    const token = CONFIG.TELEGRAM_BOT_TOKEN;
    const chatId = CONFIG.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; // opt-in: 둘 다 set이어야 동작

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: false
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const resp = await axios.post(url, payload, { timeout: 10000 });
            if (resp.data && resp.data.ok) {
                log.info('Telegram', `알림 전송 성공 (message_id=${resp.data.result?.message_id})`);
                return;
            }
            log.warn('Telegram', `응답 ok=false: ${JSON.stringify(resp.data)}`);
        } catch (err) {
            const msg = err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
            log.error('Telegram', `전송 실패 (시도 ${attempt}/2): ${msg}`);
            if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
        }
    }
}

// ==================== Circuit Breaker ====================
function createCircuitBreaker(name, { threshold = 5, resetTimeout = 60000 } = {}) {
    return {
        name,
        failures: 0,
        threshold,
        resetTimeout,
        state: 'closed', // closed, open, half-open
        lastFailure: 0,
        recordSuccess() {
            this.failures = 0;
            this.state = 'closed';
        },
        recordFailure() {
            this.failures++;
            this.lastFailure = Date.now();
            if (this.failures >= this.threshold) {
                this.state = 'open';
                log.warn('CircuitBreaker', `${this.name} OPEN (${this.failures} failures)`);
            }
        },
        isAvailable() {
            if (this.state === 'closed') return true;
            if (this.state === 'open' && Date.now() - this.lastFailure > this.resetTimeout) {
                this.state = 'half-open';
                return true;
            }
            return this.state === 'half-open';
        },
        getStatus() {
            return { name: this.name, state: this.state, failures: this.failures };
        }
    };
}

const circuitBreakers = {
    grok: createCircuitBreaker('grok', { threshold: 5, resetTimeout: 60000 }),
    whisper: createCircuitBreaker('whisper', { threshold: 3, resetTimeout: 120000 }),
    supabase: createCircuitBreaker('supabase', { threshold: 5, resetTimeout: 30000 }),
};

// ==================== Security Helpers ====================
function escapeIlike(str) {
    return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function isValidYouTubeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        const validHosts = ['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com'];
        return validHosts.includes(parsed.hostname);
    } catch {
        return false;
    }
}

// ==================== Memory Management ====================
function enforceJobLimit(map, maxSize) {
    if (map.size <= maxSize) return;
    // 가장 오래된 완료 작업부터 제거
    const entries = Array.from(map.entries());
    const completed = entries.filter(([, j]) => j.status === 'completed' || j.status === 'error');
    completed.sort((a, b) => (a[1].startTime || 0) - (b[1].startTime || 0));
    for (const [key] of completed) {
        map.delete(key);
        if (map.size <= maxSize) return;
    }
    // 그래도 초과하면 가장 오래된 것부터 제거
    for (const [key] of entries) {
        map.delete(key);
        if (map.size <= maxSize) return;
    }
}

const app = express();
const PORT = CONFIG.PORT;
// AI API 설정 - Grok API 사용
// 2026-04 기준 가용 모델 (최신순):
//   grok-4.20-0309-non-reasoning (2026-03, 최신 4.20)
//   grok-4-1-fast-non-reasoning  (2025-11, 빠르고 저렴, 요약에 최적)
//   grok-4-fast-non-reasoning    (2025-09, 검증됨)
//   grok-4-0709, grok-3, grok-3-mini (구버전 폴백)
// 요약/번역 작업은 non-reasoning fast 계열이 비용/속도 모두 우수
const AI_MODEL = process.env.AI_MODEL || 'grok-4-1-fast-non-reasoning';
const AI_MODEL_FALLBACKS = (
    AI_MODEL ? [AI_MODEL] : []
).concat([
    'grok-4-1-fast-non-reasoning',
    'grok-4-fast-non-reasoning',
    'grok-4.20-0309-non-reasoning',
    'grok-4-0709',
    'grok-3',
    'grok-3-mini'
]);

// API 설정
const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://api.x.ai/v1';
const AI_API_KEY = process.env.AI_API_KEY || '';

// Supabase 설정
const supabaseUrl = process.env.SUPABASE_URL || 'your-supabase-url';
const supabaseKey = process.env.SUPABASE_KEY || 'your-supabase-anon-key';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.warn('⚠️  Supabase 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.');
}

const supabase = createClient(supabaseUrl, supabaseKey);


// 백그라운드 작업 큐
const backgroundJobs = new Map();
const sieunJobs = new Map();

// 주기적 작업 정리 (10분 간격)
setInterval(() => {
    const now = Date.now();
    // 완료 30분 경과 작업 제거
    for (const [jobId, job] of backgroundJobs) {
        const elapsed = now - (job.endTime || job.startTime || now);
        if ((job.status === 'completed' || job.status === 'error') && elapsed > 30 * 60 * 1000) {
            backgroundJobs.delete(jobId);
            progressTrackers.delete(jobId);
        }
        // 1시간 이상 stuck 작업 제거
        if (job.status === 'processing' && elapsed > 60 * 60 * 1000) {
            log.warn('Cleanup', `Stuck job removed: ${jobId}`);
            backgroundJobs.delete(jobId);
            progressTrackers.delete(jobId);
        }
    }
    for (const [jobId, job] of sieunJobs) {
        const elapsed = now - (job.startTime || now);
        if ((job.status === 'completed' || job.status === 'error') && elapsed > 30 * 60 * 1000) {
            sieunJobs.delete(jobId);
        }
        if (job.status === 'processing' && elapsed > 60 * 60 * 1000) {
            log.warn('Cleanup', `Stuck sieun job removed: ${jobId}`);
            sieunJobs.delete(jobId);
        }
    }
    enforceJobLimit(backgroundJobs, CONFIG.MAX_JOBS);
    enforceJobLimit(sieunJobs, CONFIG.MAX_JOBS);
}, 10 * 60 * 1000);

// Google Translate 설정 (환경변수가 있는 경우)
let translator = null;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    translator = new Translate();
}


// YouTube 제목 추출 함수 (한글 인코딩 지원)
async function getYouTubeTitle(youtubeUrl) {
    return new Promise((resolve) => {
        // 쿠키 파일 경로 확인
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        const ytArgs = [
            '--legacy-server-connect',
            '--no-check-certificate',
            '--force-ipv4',
            '--extractor-args', 'youtube:player_client=default',
            '-f', 'bestaudio/best'
        ];

        // 쿠키 파일이 존재하면 추가
        if (fs.existsSync(cookiesPath)) {
            ytArgs.push('--cookies', cookiesPath);
        }

        ytArgs.push('--get-title', '--encoding', 'utf-8', youtubeUrl);

        const ytProcess = spawn('yt-dlp', ytArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: {
                ...process.env,
                PYTHONIOENCODING: 'utf-8',
                PYTHONHTTPSVERIFY: '0'
            }
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

// MP4를 MP3로 변환 (안정화 버전)
async function convertMP4ToMP3(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        // 입력 파일 존재 검증
        if (!fs.existsSync(inputPath)) {
            return reject(new Error(`입력 파일이 존재하지 않습니다: ${inputPath}`));
        }

        const inputSize = getFileSizeMB(inputPath);
        console.log(`[MP4→MP3] 변환 시작: ${inputPath} (${inputSize.toFixed(2)}MB)`);

        let stderrData = '';
        let isResolved = false;

        const ffmpegProcess = spawn('ffmpeg', [
            '-i', inputPath,
            '-vn', // 비디오 스트림 제거
            '-acodec', 'mp3',
            '-ab', '192k',
            '-ar', '44100',
            '-y', // 덮어쓰기
            outputPath
        ], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        // stderr 수집 (FFmpeg 진행률 및 오류 메시지)
        ffmpegProcess.stderr.on('data', (data) => {
            stderrData += data.toString();
        });

        // 5분 타임아웃 (대용량 파일 대비)
        const timeout = setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                ffmpegProcess.kill('SIGKILL');
                console.error('[MP4→MP3] 타임아웃 (5분 초과)');
                reject(new Error('MP4→MP3 변환 타임아웃 (5분 초과). 파일이 너무 크거나 손상되었을 수 있습니다.'));
            }
        }, 5 * 60 * 1000);

        ffmpegProcess.on('close', (code) => {
            clearTimeout(timeout);
            if (isResolved) return;
            isResolved = true;

            if (code === 0) {
                // 출력 파일 검증
                if (fs.existsSync(outputPath)) {
                    const outputSize = getFileSizeMB(outputPath);
                    console.log(`[MP4→MP3] 변환 완료: ${outputPath} (${outputSize.toFixed(2)}MB)`);
                    resolve(outputPath);
                } else {
                    console.error('[MP4→MP3] 출력 파일이 생성되지 않음');
                    reject(new Error('MP3 파일이 생성되지 않았습니다.'));
                }
            } else {
                console.error(`[MP4→MP3] FFmpeg 오류 (코드: ${code})`);
                console.error('[MP4→MP3] stderr:', stderrData.slice(-500)); // 마지막 500자
                reject(new Error(`FFmpeg 변환 실패 (코드: ${code}). ${stderrData.slice(-200)}`));
            }
        });

        ffmpegProcess.on('error', (error) => {
            clearTimeout(timeout);
            if (isResolved) return;
            isResolved = true;
            console.error('[MP4→MP3] 프로세스 오류:', error.message);
            reject(new Error(`FFmpeg 실행 오류: ${error.message}`));
        });
    });
}

function getFileSizeMB(p) {
    try { return fs.statSync(p).size / (1024*1024); } catch { return 0; }
}

// 임시 파일 안전 삭제 헬퍼
function safeUnlink(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[Cleanup] 삭제됨: ${path.basename(filePath)}`);
        }
    } catch (e) {
        console.warn(`[Cleanup] 삭제 실패: ${filePath}`, e.message);
    }
}

// Whisper용 오디오 준비 (안정화 버전)
async function prepareAudioForWhisper(inputPath) {
    const tmpDir = path.join(__dirname, 'uploads', 'temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // 고유 ID로 임시 파일명 충돌 방지
    const uniqueId = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const base = path.parse(inputPath).name;
    const reducedPath = path.join(tmpDir, `${uniqueId}_${base}.whisper.mp3`);
    const createdFiles = [reducedPath]; // 정리 대상 추적

    try {
        console.log(`[Whisper준비] 입력: ${inputPath} (${getFileSizeMB(inputPath).toFixed(2)}MB)`);

        // 1) 저용량/저샘플링으로 변환 (16kHz, mono, 32kbps)
        await new Promise((resolve, reject) => {
            let stderrData = '';
            const p = spawn('ffmpeg', ['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-b:a', '32k', reducedPath], {
                stdio: ['ignore', 'ignore', 'pipe'],
                windowsHide: true
            });
            p.stderr.on('data', d => stderrData += d.toString());
            p.on('close', c => {
                if (c === 0) resolve();
                else reject(new Error(`FFmpeg 리샘플링 실패 (코드: ${c}). ${stderrData.slice(-200)}`));
            });
            p.on('error', reject);
        });

        const reducedSize = getFileSizeMB(reducedPath);
        console.log(`[Whisper준비] 리샘플링 완료: ${reducedSize.toFixed(2)}MB`);

        // 2) 24MB 이하면 단일 파일 반환
        if (reducedSize <= 24) {
            return { files: [reducedPath], cleanup: () => safeUnlink(reducedPath) };
        }

        // 3) 24MB 초과 시 15분 단위로 분할
        console.log(`[Whisper준비] 24MB 초과, 분할 시작...`);
        const pattern = path.join(tmpDir, `${uniqueId}_${base}.seg_%03d.mp3`);

        await new Promise((resolve, reject) => {
            const p = spawn('ffmpeg', [
                '-y', '-i', reducedPath,
                '-ac', '1', '-ar', '16000', '-b:a', '32k',
                '-f', 'segment', '-segment_time', '900', '-reset_timestamps', '1',
                pattern
            ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
            p.on('close', c => c === 0 ? resolve() : reject(new Error('FFmpeg 분할 실패')));
            p.on('error', reject);
        });

        // 분할된 파일 수집
        const segFiles = fs.readdirSync(tmpDir)
            .filter(n => n.startsWith(`${uniqueId}_${base}.seg_`) && n.endsWith('.mp3'))
            .map(n => path.join(tmpDir, n))
            .sort();

        // 정리 대상에 추가
        segFiles.forEach(f => createdFiles.push(f));

        console.log(`[Whisper준비] 분할 완료: ${segFiles.length}개 청크`);

        // cleanup 함수 반환 (모든 임시 파일 정리)
        return {
            files: segFiles.length ? segFiles : [reducedPath],
            cleanup: () => createdFiles.forEach(f => safeUnlink(f))
        };

    } catch (error) {
        // 오류 시 생성된 임시 파일 정리
        createdFiles.forEach(f => safeUnlink(f));
        throw error;
    }
}

async function uploadChunkToWhisper(filePath, apiKey, language) {
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath));
    formData.append('model', 'whisper-1');
    if (language) formData.append('language', language);

    if (!circuitBreakers.whisper.isAvailable()) {
        throw new Error('Whisper API 서킷 브레이커 OPEN - 잠시 후 재시도해주세요');
    }
    // 간단한 재시도(최대 3회)
    let lastErr;
    for (let i=0;i<3;i++) {
        try {
            const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
                headers: { Authorization: `Bearer ${apiKey}`, ...formData.getHeaders() },
                maxBodyLength: Infinity,
                timeout: 300000
            });
            circuitBreakers.whisper.recordSuccess();
            return (response.data && response.data.text) || '';
        } catch (e) {
            circuitBreakers.whisper.recordFailure();
            lastErr = e;
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
        }
    }
    throw lastErr || new Error('whisper upload failed');
}

// Markdown 포맷팅 함수 - 영어 텍스트
function formatEnglishMarkdown(text) {
    // 날짜 감지 패턴
    const datePattern = /^(January|February|March|April|May|June|July|August|September|October|November|December|\d{1,2}월|\d{4}년|\d{1,2}일|Today|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i;

    // 텍스트를 문장 단위로 분리 (마침표, 느낌표, 물음표 기준)
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    let markdown = '# English Transcription\n\n';
    let currentParagraph = '';
    let currentDate = '';

    sentences.forEach(sentence => {
        sentence = sentence.trim();

        // 날짜가 포함된 문장인지 확인
        if (datePattern.test(sentence)) {
            // 이전 단락이 있으면 추가
            if (currentParagraph) {
                markdown += currentParagraph + '\n\n';
                currentParagraph = '';
            }

            // 날짜를 소제목으로 추가
            const dateMatch = sentence.match(datePattern);
            if (dateMatch && dateMatch[0] !== currentDate) {
                currentDate = dateMatch[0];
                markdown += `## ${currentDate}\n\n`;
            }
        }

        currentParagraph += sentence + ' ';

        // 3-4 문장마다 단락 구분
        const sentenceCount = (currentParagraph.match(/[.!?]/g) || []).length;
        if (sentenceCount >= 3) {
            markdown += currentParagraph.trim() + '\n\n';
            currentParagraph = '';
        }
    });

    // 남은 내용 추가
    if (currentParagraph) {
        markdown += currentParagraph.trim() + '\n';
    }

    return markdown;
}

// Markdown 포맷팅 함수 - 한글 텍스트
function formatKoreanMarkdown(text) {
    // 이미 Markdown 형식인 경우 그대로 반환
    if (text.includes('#') || text.includes('##')) {
        return text;
    }

    // 날짜 감지 패턴 (한국어)
    const datePattern = /(\d{1,2}월\s*\d{1,2}일|\d{4}년|오늘|월요일|화요일|수요일|목요일|금요일|토요일|일요일)/;

    // 텍스트를 문장 단위로 분리
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    let markdown = '# 한글 번역\n\n';
    let currentParagraph = '';
    let currentDate = '';

    sentences.forEach(sentence => {
        sentence = sentence.trim();

        // 날짜가 포함된 문장인지 확인
        if (datePattern.test(sentence)) {
            // 이전 단락이 있으면 추가
            if (currentParagraph) {
                markdown += currentParagraph + '\n\n';
                currentParagraph = '';
            }

            // 날짜를 소제목으로 추가
            const dateMatch = sentence.match(datePattern);
            if (dateMatch && dateMatch[0] !== currentDate) {
                currentDate = dateMatch[0];
                markdown += `## ${currentDate}\n\n`;
            }
        }

        currentParagraph += sentence + ' ';

        // 3-4 문장마다 단락 구분
        const sentenceCount = (currentParagraph.match(/[.!?]/g) || []).length;
        if (sentenceCount >= 3) {
            markdown += currentParagraph.trim() + '\n\n';
            currentParagraph = '';
        }
    });

    // 남은 내용 추가
    if (currentParagraph) {
        markdown += currentParagraph.trim() + '\n';
    }

    // 특수한 섹션 감지 및 포맷팅
    markdown = markdown
        .replace(/학습 포인트:/g, '\n### 📚 학습 포인트\n')
        .replace(/주요 내용:/g, '\n### 📌 주요 내용\n')
        .replace(/감사합니다/g, '\n---\n\n감사합니다');

    return markdown;
}

// 음성인식 (OpenAI Whisper API - 영어, 시은이용) - 안정화 버전
async function transcribeAudio(audioPath) {
    let preparedAudio = null;

    try {
        // OpenAI API 키 설정
        const apiKey = process.env.OPENAI_API_KEY || '';

        if (!apiKey || apiKey === 'your-openai-api-key') {
            throw new Error('OpenAI API 키가 설정되지 않았습니다.');
        }

        console.log('[STT-EN] Whisper 준비 시작:', audioPath);
        preparedAudio = await prepareAudioForWhisper(audioPath);
        const chunks = preparedAudio.files;

        let combined = '';
        let emptyCount = 0;

        for (let i = 0; i < chunks.length; i++) {
            console.log(`[STT-EN] Whisper 업로드 (${i + 1}/${chunks.length}): ${path.basename(chunks[i])}`);

            // 빈 결과 시 재시도 (최대 2회)
            let text = '';
            for (let retry = 0; retry < 2; retry++) {
                text = await uploadChunkToWhisper(chunks[i], apiKey, 'en');
                if (text && text.trim().length > 0) break;
                console.log(`[STT-EN] 빈 결과, 재시도 ${retry + 1}/2`);
                await new Promise(r => setTimeout(r, 1000));
            }

            if (!text || text.trim().length === 0) {
                emptyCount++;
                console.warn(`[STT-EN] 청크 ${i + 1} 결과 없음`);
            } else {
                combined += (combined ? '\n\n' : '') + text.trim();
            }
        }

        // 모든 청크가 빈 결과인 경우
        if (emptyCount === chunks.length) {
            throw new Error('모든 오디오 청크에서 음성이 인식되지 않았습니다. 오디오에 영어 음성이 포함되어 있는지 확인해주세요.');
        }

        console.log(`[STT-EN] 완료: ${combined.length}자 (빈 청크: ${emptyCount}/${chunks.length})`);
        const finalText = combined || '인식된 텍스트가 없습니다.';
        return formatEnglishMarkdown(finalText);

    } catch (error) {
        console.error('[STT-EN] 오류:', error.message);
        throw error; // 상위로 전파하여 사용자에게 정확한 오류 표시

    } finally {
        // 임시 파일 정리
        if (preparedAudio && preparedAudio.cleanup) {
            console.log('[STT-EN] 임시 파일 정리 중...');
            preparedAudio.cleanup();
        }
    }
}

// 음성인식 - 한국어 전용 (SUMMARY용) - 안정화 버전
async function transcribeAudioKorean(audioPath) {
    let preparedAudio = null;

    try {
        const apiKey = process.env.OPENAI_API_KEY || '';

        if (!apiKey || apiKey === 'your-openai-api-key') {
            throw new Error('OpenAI API 키가 설정되지 않았습니다.');
        }

        console.log('[STT-KO] Whisper 준비 시작:', audioPath);
        preparedAudio = await prepareAudioForWhisper(audioPath);
        const chunks = preparedAudio.files;

        let combined = '';
        let emptyCount = 0;

        for (let i = 0; i < chunks.length; i++) {
            console.log(`[STT-KO] Whisper 업로드 (${i + 1}/${chunks.length}): ${path.basename(chunks[i])}`);

            // 빈 결과 시 재시도 (최대 2회)
            let text = '';
            for (let retry = 0; retry < 2; retry++) {
                text = await uploadChunkToWhisper(chunks[i], apiKey, 'ko');
                if (text && text.trim().length > 0) break;
                console.log(`[STT-KO] 빈 결과, 재시도 ${retry + 1}/2`);
                await new Promise(r => setTimeout(r, 1000));
            }

            if (!text || text.trim().length === 0) {
                emptyCount++;
                console.warn(`[STT-KO] 청크 ${i + 1} 결과 없음`);
            } else {
                combined += (combined ? '\n\n' : '') + text.trim();
            }
        }

        // 모든 청크가 빈 결과인 경우
        if (emptyCount === chunks.length) {
            throw new Error('모든 오디오 청크에서 음성이 인식되지 않았습니다.');
        }

        console.log(`[STT-KO] 완료: ${combined.length}자 (빈 청크: ${emptyCount}/${chunks.length})`);
        return combined || '인식된 텍스트가 없습니다.';

    } catch (error) {
        console.error('[STT-KO] 오류:', error.message);
        throw error;

    } finally {
        if (preparedAudio && preparedAudio.cleanup) {
            console.log('[STT-KO] 임시 파일 정리 중...');
            preparedAudio.cleanup();
        }
    }
}

// 영어를 한글로 번역 (Grok API) - 안정화 버전 (청크 분할 지원)
async function translateToKorean(englishText) {
    const apiKey = AI_API_KEY || '';
    const maxRetries = 3;
    const CHUNK_SIZE = 3000; // 청크당 최대 글자 수

    // Google Translate 우선 사용
    if (translator) {
        try {
            console.log('[번역] Google Translate 사용 중...');
            const [translation] = await translator.translate(englishText, 'ko');
            return formatKoreanMarkdown(translation);
        } catch (e) {
            console.warn('[번역] Google Translate 실패, Grok으로 폴백:', e.message);
        }
    }

    if (!apiKey || apiKey === 'your-ai-api-key') {
        throw new Error('번역 API가 설정되지 않았습니다.');
    }

    // 텍스트를 문단 단위로 청크 분할
    const chunks = splitTextIntoChunks(englishText, CHUNK_SIZE);
    console.log(`[번역] Grok API 사용: ${englishText.length}자 → ${chunks.length}개 청크`);

    let translatedParts = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`[번역] 청크 ${i + 1}/${chunks.length} 번역 중 (${chunk.length}자)...`);

        let retryCount = 0;
        let translated = null;

        while (retryCount < maxRetries && !translated) {
            try {
                const response = await axios.post(`${AI_API_BASE_URL}/chat/completions`, {
                    model: AI_MODEL,
                    messages: [{
                        role: 'system',
                        content: '당신은 영어를 자연스러운 한국어로 번역하는 전문 번역가입니다. 원문을 최대한 그대로 번역해주세요. 문단을 나누어서 읽기 쉽게 만들어주세요.'
                    }, {
                        role: 'user',
                        content: `다음 영어 텍스트를 한국어로 번역해주세요:\n\n${chunk}`
                    }],
                    temperature: 0.3,
                    max_tokens: 2000 // 1200 → 2000으로 증가
                }, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 45000 // 25초 → 45초로 증가
                });

                translated = response.data.choices[0].message.content;

            } catch (error) {
                retryCount++;
                const isRetryable = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(error.code);

                if (isRetryable && retryCount < maxRetries) {
                    console.warn(`[번역] 청크 ${i + 1} 오류, 재시도 ${retryCount}/${maxRetries}: ${error.code}`);
                    await new Promise(r => setTimeout(r, 2000 * retryCount));
                } else {
                    console.error(`[번역] 청크 ${i + 1} 최종 실패:`, error.message);
                    translated = `[번역 실패: ${chunk.substring(0, 50)}...]`;
                }
            }
        }

        translatedParts.push(translated || '');
    }

    const fullTranslation = translatedParts.join('\n\n');
    console.log(`[번역] 완료: ${fullTranslation.length}자`);
    return formatKoreanMarkdown(fullTranslation);
}

// 텍스트를 문단 단위로 청크 분할
function splitTextIntoChunks(text, maxSize) {
    if (text.length <= maxSize) return [text];

    const paragraphs = text.split(/\n\n+/);
    const chunks = [];
    let currentChunk = '';

    for (const para of paragraphs) {
        if ((currentChunk + '\n\n' + para).length > maxSize && currentChunk) {
            chunks.push(currentChunk.trim());
            currentChunk = para;
        } else {
            currentChunk += (currentChunk ? '\n\n' : '') + para;
        }
    }

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    return chunks.length ? chunks : [text.substring(0, maxSize)];
}

// 시은이 히스토리를 Supabase에 저장
async function saveSieunHistory(data) {
    try {
        if (supabaseUrl === 'your-supabase-url' || supabaseKey === 'your-supabase-anon-key') {
            console.log('Supabase 설정이 없어서 저장을 건너뜁니다.');
            return null;
        }

        const { data: result, error } = await supabase
            .from('sieun_history')
            .insert([{
                original_filename: data.originalFilename,
                english_text: data.englishText,
                korean_text: data.koreanText,
                mp3_file_path: data.mp3FilePath,
                created_at: new Date().toISOString()
            }])
            .select();

        if (error) {
            console.error('Supabase 저장 오류:', error);
            return null;
        }

        console.log('시은이 히스토리 저장 완료');
        return result[0];
    } catch (error) {
        console.error('시은이 히스토리 저장 중 오류:', error);
        return null;
    }
}

// youtube_summary.url 컬럼 미존재 오류 감지 (SQL_MP4_SUMMARY.md의 ALTER TABLE 미실행 상태)
function isMissingUrlColumn(error) {
    if (!error) return false;
    const msg = String(error.message || '');
    return error.code === '42703' || (/column/i.test(msg) && /\burl\b/i.test(msg));
}

// SUMMARY: STT (본문)만 생성 후 supabase youtube_summary에 저장 (요약 youyak 생성 제거)
async function processSummaryForMp3(mp3Path, title, youtubeUrl) {
    try {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
            console.log('Supabase 미설정으로 SUMMARY 저장을 건너뜁니다.');
            return null;
        }

        const bonmun = await transcribeAudioKorean(mp3Path);

        // 문단 구분: 문장 사이에 빈 줄 유지
        const normalizedBonmun = bonmun
            .split(/\n+/)
            .map(p => p.trim())
            .filter(Boolean)
            .join('\n\n');

        const insertRow = {
            jemok: (title || '').replace(/^\d+[_-]*/, ''),
            bonmun: normalizedBonmun,
            url: youtubeUrl || null,
            youyak: '', // youyak 컬럼이 NOT NULL 제약을 갖고 있어 빈 값으로 채움 (요약 생성은 제거됨)
            created_at: new Date().toISOString()
        };
        let { data, error } = await supabase
            .from('youtube_summary')
            .insert([insertRow])
            .select();

        // url/youyak 컬럼이 DB에 없는 경우(스키마 차이) 해당 필드 제거 후 재시도
        if (error && error.code === '42703') {
            console.warn('youtube_summary 컬럼 불일치로 축소 저장합니다:', error.message);
            if (/\burl\b/i.test(String(error.message))) delete insertRow.url;
            if (/youyak/i.test(String(error.message))) delete insertRow.youyak;
            ({ data, error } = await supabase.from('youtube_summary').insert([insertRow]).select());
        }

        if (error) throw error;
        return data && data[0];
    } catch (e) {
        console.error('SUMMARY 처리/저장 오류:', e);
        return null;
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
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
// 기본 정적 파일 제공
app.use('/uploads', express.static('uploads'));
// 시은 작업물 정적 제공
const sieunDir = path.join(__dirname, 'sieun');
if (!fs.existsSync(sieunDir)) {
    fs.mkdirSync(sieunDir, { recursive: true });
}
app.use('/sieun', express.static('sieun'));

// 오디오 파일 전용 라우트 (Range 요청 지원)
app.get('/audio/:filename', (req, res) => {
    // 경로 순회 공격 방지
    const filename = path.basename(req.params.filename);
    const filePath = path.join(__dirname, 'uploads', filename);
    const resolvedPath = path.resolve(filePath);
    const uploadsDir = path.resolve(path.join(__dirname, 'uploads'));
    if (!resolvedPath.startsWith(uploadsDir)) {
        return res.status(403).json({ error: '접근이 거부되었습니다.' });
    }

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
        // Range bounds 검증
        if (isNaN(start) || start < 0 || start >= fileSize || end >= fileSize || end < start) {
            res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
            return res.end();
        }
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

// MP4 요약 저장 디렉토리 생성 (원본/요약 mp4 + 로컬 폴백 index.json)
const mp4Dir = path.join(__dirname, 'mp4');
if (!fs.existsSync(mp4Dir)) {
    fs.mkdirSync(mp4Dir, { recursive: true });
}
const MP4_INDEX_PATH = path.join(mp4Dir, 'index.json');

// MP4 파일 전용 라우트 (Range 요청 지원, .mp4만 허용, 경로 순회 방지)
app.get('/mp4/:filename', (req, res) => {
    const filename = path.basename(req.params.filename);
    if (!filename.toLowerCase().endsWith('.mp4')) {
        return res.status(403).json({ error: '접근이 거부되었습니다.' });
    }
    const filePath = path.join(mp4Dir, filename);
    const resolvedPath = path.resolve(filePath);
    const baseDir = path.resolve(mp4Dir);
    if (!resolvedPath.startsWith(baseDir)) {
        return res.status(403).json({ error: '접근이 거부되었습니다.' });
    }
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (isNaN(start) || start < 0 || start >= fileSize || end >= fileSize || end < start) {
            res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
            return res.end();
        }
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Range',
            'Cache-Control': 'no-cache'
        });
        file.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache'
        });
        fs.createReadStream(filePath).pipe(res);
    }
});

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
async function handleMp3Extraction(req, res, { youtubeUrl, startTime, endTime, title, makeMp4 }) {
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
        enforceJobLimit(backgroundJobs, CONFIG.MAX_JOBS);
        backgroundJobs.set(jobId, {
            status: 'processing',
            fileName: fileName,
            title: finalTitle,
            startTime: new Date()
        });

        // 백그라운드에서 비동기 처리 시작
        processMP3InBackground(jobId, youtubeUrl, startTime, endTime, isFullVideo, outputPath, fileName, finalTitle, makeMp4);

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

// yt-dlp 다운로드 실행 (Promise 래핑)
function runYtdlp(args, jobId, timeoutMs) {
    return new Promise((resolve, reject) => {
        console.log('yt-dlp 명령어:', 'yt-dlp', args.join(' '));

        const childProcess = spawn('yt-dlp', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: {
                ...process.env,
                PYTHONIOENCODING: 'utf-8',
                PYTHONHTTPSVERIFY: '0'
            }
        });

        const ytdlpTimeout = setTimeout(() => {
            try { childProcess.kill('SIGTERM'); } catch(e) {}
            reject(new Error('yt-dlp timeout'));
        }, timeoutMs);

        let downloadProgress = 10;
        let outputBuffer = '';
        let errorBuffer = '';
        const MAX_BUFFER = 100 * 1024;

        childProcess.stdout.on('data', (data) => {
            const output = data.toString();
            outputBuffer += output;
            if (outputBuffer.length > MAX_BUFFER) outputBuffer = outputBuffer.slice(-MAX_BUFFER);
            console.log('yt-dlp stdout:', output);

            const progressMatch = output.match(/(\d+\.\d+)%/);
            if (progressMatch) {
                const percent = parseFloat(progressMatch[1]);
                downloadProgress = Math.min(10 + (percent * 0.7), 80);
                broadcastProgress(jobId, {
                    type: 'progress',
                    stage: 'downloading',
                    message: `다운로드 중... ${percent.toFixed(1)}%`,
                    progress: Math.round(downloadProgress)
                });
            }

            if (output.includes('[ExtractAudio]')) {
                broadcastProgress(jobId, {
                    type: 'progress',
                    stage: 'converting',
                    message: '오디오 변환 중...',
                    progress: 85
                });
            }
        });

        childProcess.stderr.on('data', (data) => {
            const error = data.toString();
            errorBuffer += error;
            if (errorBuffer.length > MAX_BUFFER) errorBuffer = errorBuffer.slice(-MAX_BUFFER);
            console.log('yt-dlp stderr:', error);
        });

        childProcess.on('close', (code) => {
            clearTimeout(ytdlpTimeout);
            console.log(`yt-dlp 프로세스 종료 코드: ${code}`);
            if (code === 0) {
                resolve({ outputBuffer, errorBuffer });
            } else {
                const err = new Error(`프로세스 종료 코드: ${code}`);
                err.errorBuffer = errorBuffer;
                err.exitCode = code;
                reject(err);
            }
        });

        childProcess.on('error', (e) => {
            clearTimeout(ytdlpTimeout);
            reject(e);
        });
    });
}

// 백그라운드 MP3 처리 함수
async function processMP3InBackground(jobId, youtubeUrl, startTime, endTime, isFullVideo, outputPath, fileName, finalTitle, makeMp4) {
    try {
        log.info('Background', `처리 시작: ${jobId}`);

        // 공통 SSL/네트워크 옵션
        const baseArgs = [
            '--legacy-server-connect',
            '--no-check-certificate',
            '--force-ipv4',
            '-f', 'bestaudio/best',
            '--add-header', 'Accept-Language:en-US,en;q=0.9',
            '--add-header', 'Sec-Fetch-Mode:navigate'
        ];

        // 쿠키 파일이 존재하면 추가
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(cookiesPath)) {
            baseArgs.push('--cookies', cookiesPath);
            console.log('쿠키 파일 사용:', cookiesPath);
        }

        broadcastProgress(jobId, {
            type: 'progress',
            stage: 'downloading',
            message: isFullVideo ? '전체 영상 다운로드 중...' : '구간 다운로드 중...',
            progress: 10
        });

        // === 1차 시도: default 클라이언트 + 구간 다운로드 ===
        let downloadSuccess = false;
        const dlArgs = [
            ...baseArgs,
            '--extractor-args', 'youtube:player_client=default',
            '-x', '--audio-format', 'mp3', '--audio-quality', '0',
            '--progress', '--newline',
            '-o', outputPath
        ];

        if (!isFullVideo) {
            dlArgs.push('--download-sections', `*${startTime}-${endTime}`);
            console.log(`다운로드 구간: *${startTime}-${endTime}`);
        } else {
            console.log('전체 비디오 다운로드');
        }
        dlArgs.push(youtubeUrl);

        try {
            await runYtdlp(dlArgs, jobId, CONFIG.YTDLP_TIMEOUT);
            downloadSuccess = true;
        } catch (firstErr) {
            const errMsg = firstErr.errorBuffer || firstErr.message || '';
            console.log('1차 다운로드 실패:', errMsg.slice(-300));

            // === 2차 시도: 라이브 다시보기 등 구간 다운로드 실패 시 전체 다운로드 후 FFmpeg 구간 추출 ===
            if (!isFullVideo && (errMsg.includes('live event has ended') || errMsg.includes('is not supported') || errMsg.includes('DASH') || errMsg.includes('Invalid data'))) {
                log.info('yt-dlp', '라이브 다시보기 감지 - 전체 다운로드 후 구간 추출 모드');
                broadcastProgress(jobId, {
                    type: 'progress',
                    stage: 'downloading',
                    message: '라이브 다시보기 영상 - 전체 다운로드 중...',
                    progress: 15
                });

                const tempFullPath = outputPath.replace('.mp3', '_full_temp.mp3');
                const fullArgs = [
                    ...baseArgs,
                    '--extractor-args', 'youtube:player_client=default',
                    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                    '--progress', '--newline',
                    '-o', tempFullPath,
                    youtubeUrl
                ];

                try {
                    await runYtdlp(fullArgs, jobId, CONFIG.YTDLP_TIMEOUT * 3); // 라이브 다시보기는 길 수 있으므로 타임아웃 3배

                    // FFmpeg로 구간 추출
                    broadcastProgress(jobId, {
                        type: 'progress',
                        stage: 'converting',
                        message: '구간 추출 중...',
                        progress: 85
                    });

                    await new Promise((resolve, reject) => {
                        const ffmpegArgs = ['-y', '-i', tempFullPath, '-ss', startTime, '-to', endTime, '-c', 'copy', outputPath];
                        console.log('FFmpeg 구간 추출:', ffmpegArgs.join(' '));
                        const p = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
                        let stderr = '';
                        p.stderr.on('data', d => stderr += d.toString());
                        p.on('close', c => {
                            if (c === 0) resolve();
                            else reject(new Error(`FFmpeg 구간 추출 실패 (코드: ${c}). ${stderr.slice(-200)}`));
                        });
                        p.on('error', reject);
                    });

                    // 임시 전체 파일 삭제
                    try { fs.unlinkSync(tempFullPath); } catch(e) {}
                    downloadSuccess = true;
                } catch (secondErr) {
                    // 임시 파일 정리
                    try { fs.unlinkSync(tempFullPath); } catch(e) {}
                    throw secondErr;
                }
            } else {
                // 구간 다운로드가 아닌 다른 에러 → 그대로 throw
                throw firstErr;
            }
        }

        if (!downloadSuccess) {
            broadcastProgress(jobId, {
                type: 'error',
                stage: 'failed',
                message: '다운로드 실패',
                error: '모든 다운로드 방법 실패'
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

        const finalUrl = `/uploads/${fileName}`;

        // SUMMARY 자동 생성 (본문) - Supabase youtube_summary 저장
        let summaryIdForMp4 = null;
        try {
            const summaryResult = await processSummaryForMp3(outputPath, finalTitle, youtubeUrl);
            summaryIdForMp4 = summaryResult && summaryResult.id;
            console.log('SUMMARY 생성 완료:', summaryIdForMp4);
        } catch (e) {
            console.log('SUMMARY 생성 실패:', e.message);
        }

        // MP4 요약 자동 생성 (체크박스 활성 시) - fire-and-forget
        if (makeMp4) {
            const mp4JobId = 'mp4_' + Date.now();
            log.info('MP4', `MP3 완료 후 MP4 요약 자동 시작: jobId=${mp4JobId}`);
            enforceJobLimit(backgroundJobs, CONFIG.MAX_JOBS);
            backgroundJobs.set(mp4JobId, {
                status: 'processing',
                kind: 'mp4-summary',
                title: finalTitle,
                startTime: new Date()
            });
            processMp4SummaryInBackground(mp4JobId, {
                youtubeUrl,
                startTime: isFullVideo ? '' : startTime,
                endTime: isFullVideo ? '' : endTime,
                title: finalTitle,
                summaryId: summaryIdForMp4
            }).catch(e => log.error('MP4', `자동 MP4 요약 실패: ${e.message}`));
        }

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
            ftpUploaded: false,
            supabaseSaved: true
        });

        // 백그라운드 작업 완료 표시
        backgroundJobs.set(jobId, {
            ...backgroundJobs.get(jobId),
            status: 'completed',
            endTime: new Date(),
            downloadUrl: finalUrl
        });

        // Telegram 완료 알림 (fire-and-forget)
        const sizeMB = (finalFileSize / 1024 / 1024).toFixed(1);
        const dlBase = CONFIG.PUBLIC_BASE_URL || '';
        const dlUrl = dlBase + '/uploads/' + encodeURIComponent(fileName);
        const nowStr = new Date().toLocaleTimeString('ko-KR', { hour12: false });
        const rangeLine = isFullVideo ? '' : `⏱ 구간: ${escapeTelegramHtml(startTime)} ~ ${escapeTelegramHtml(endTime)}\n`;
        const successText =
            `✅ <b>MP3 변환 완료</b>\n\n` +
            `📁 파일: ${escapeTelegramHtml(fileName)}\n` +
            `📦 크기: ${sizeMB} MB\n` +
            `📝 제목: ${escapeTelegramHtml(finalTitle)}\n` +
            rangeLine +
            `\n🔗 원본: ${escapeTelegramHtml(youtubeUrl)}\n` +
            `▶ <a href="${dlUrl}">다운로드</a>\n\n` +
            `🕐 ${nowStr}`;
        notifyTelegram(successText).catch(e => log.error('Telegram', `완료 알림 실패: ${e.message}`));

        // 작업 정리
        setTimeout(() => {
            progressTrackers.delete(jobId);
            backgroundJobs.delete(jobId);
        }, CONFIG.JOB_CLEANUP_DELAY);

    } catch (error) {
        console.error('백그라운드 처리 오류:', error);
        broadcastProgress(jobId, {
            type: 'error',
            stage: 'failed',
            message: '백그라운드 처리 중 오류가 발생했습니다.',
            error: error.message
        });

        // Telegram 실패 알림 (fire-and-forget)
        const titleSafe = (typeof finalTitle !== 'undefined' && finalTitle) ? finalTitle : '(미상)';
        const nowStr = new Date().toLocaleTimeString('ko-KR', { hour12: false });
        const errorText =
            `❌ <b>MP3 변환 실패</b>\n\n` +
            `📝 제목: ${escapeTelegramHtml(titleSafe)}\n` +
            `🔗 원본: ${escapeTelegramHtml(youtubeUrl)}\n` +
            `⚠ 오류: ${escapeTelegramHtml(error.message)}\n\n` +
            `🕐 ${nowStr}`;
        notifyTelegram(errorText).catch(e => log.error('Telegram', `실패 알림 실패: ${e.message}`));

        backgroundJobs.delete(jobId);
    }
}


// YouTube에서 MP3 추출 API (개선된 버전)
app.post('/api/extract-mp3', async (req, res) => {
    const { youtubeUrl, startTime, endTime, title, makeMp4 } = req.body;

    // YouTube URL은 필수, 시간과 제목은 선택사항
    if (!youtubeUrl) {
        return res.status(400).json({ error: 'YouTube URL이 필요합니다.' });
    }
    if (!isValidYouTubeUrl(youtubeUrl)) {
        return res.status(400).json({ error: '유효한 YouTube URL이 아닙니다.' });
    }

    // Count active jobs
    const activeJobs = Array.from(backgroundJobs.values()).filter(j => j.status === 'processing').length;
    if (activeJobs >= CONFIG.MAX_CONCURRENT_JOBS) {
        return res.status(429).json({ error: `동시 처리 가능한 작업이 초과되었습니다. 잠시 후 다시 시도해주세요. (최대 ${CONFIG.MAX_CONCURRENT_JOBS}개)` });
    }

    return handleMp3Extraction(req, res, { youtubeUrl, startTime, endTime, title, makeMp4: !!makeMp4 });
});

// youtube_summary 목록 조회 (검색/페이지네이션)
app.get('/api/summary', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const q = (req.query.q || '').trim();
        const offset = (page - 1) * limit;

        // 목록용: id, jemok, url, created_at + bonmun 앞부분만 조회 (성능 최적화)
        const buildQuery = (columns) => {
            let query = supabase.from('youtube_summary').select(columns, { count: 'exact' }).order('created_at', { ascending: false });
            if (q) {
                const eq = escapeIlike(q);
                query = query.or(`jemok.ilike.%${eq}%,bonmun.ilike.%${eq}%`);
            }
            return query.range(offset, offset + limit - 1);
        };
        let { data, count, error } = await buildQuery('id,jemok,bonmun,url,created_at');

        // url 컬럼 미생성(SQL_MP4_SUMMARY.md 미실행) 시 url 없이 재조회
        if (error && isMissingUrlColumn(error)) {
            ({ data, count, error } = await buildQuery('id,jemok,bonmun,created_at'));
        }
        if (error) throw error;

        // bonmun을 300자로 잘라서 전송 (목록에서는 미리보기만 필요)
        const trimmedData = (data || []).map(item => ({
            ...item,
            bonmun: item.bonmun ? item.bonmun.substring(0, 300) : ''
        }));

        res.json({
            items: trimmedData,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil((count || 0) / limit),
                totalItems: count || 0,
                itemsPerPage: limit
            }
        });
    } catch (error) {
        console.error('summary list error:', error);
        res.status(500).json({ error: 'summary list error' });
    }
});

// youtube_summary 생성
app.post('/api/summary', async (req, res) => {
    try {
        const { jemok, bonmun, url } = req.body;
        if (!jemok || !bonmun) return res.status(400).json({ error: '필수 항목 누락' });
        const insertRow = { jemok, bonmun, youyak: '' }; // youyak NOT NULL 제약 대응
        if (url !== undefined) insertRow.url = url;
        let { data, error } = await supabase.from('youtube_summary').insert([insertRow]).select();
        // url/youyak 컬럼이 DB에 없는 경우(스키마 차이) 해당 필드 제거 후 재시도
        if (error && error.code === '42703') {
            if (/\burl\b/i.test(String(error.message))) delete insertRow.url;
            if (/youyak/i.test(String(error.message))) delete insertRow.youyak;
            ({ data, error } = await supabase.from('youtube_summary').insert([insertRow]).select());
        }
        if (error) throw error;
        res.json({ success: true, item: data && data[0] });
    } catch (error) {
        console.error('summary create error:', error);
        res.status(500).json({ error: 'summary create error' });
    }
});

// youtube_summary 수정
app.put('/api/summary/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { jemok, bonmun, url } = req.body;
        const updateRow = { jemok, bonmun };
        if (url !== undefined) updateRow.url = url;
        const { data, error } = await supabase.from('youtube_summary').update(updateRow).eq('id', id).select();
        if (error) throw error;
        res.json({ success: true, item: data && data[0] });
    } catch (error) {
        console.error('summary update error:', error);
        res.status(500).json({ error: 'summary update error' });
    }
});

// youtube_summary 삭제
app.delete('/api/summary/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('youtube_summary').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('summary delete error:', error);
        res.status(500).json({ error: 'summary delete error' });
    }
});

// youtube_summary 상세
app.get('/api/summary/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase.from('youtube_summary').select('*').eq('id', id).single();
        if (error) throw error;
        res.json({ item: data });
    } catch (error) {
        console.error('summary get error:', error);
        res.status(500).json({ error: 'summary get error' });
    }
});

// 외부 API - 간단한 MP3 추출 (GET 요청 지원) - 개선된 버전
app.get('/api/convert', async (req, res) => {
    try {
        const { url, start, end, title, makeMp4 } = req.query;

        // URL만 필수, 나머지는 선택사항
        if (!url) {
            return res.status(400).json({
                error: 'YouTube URL이 필요합니다.',
                required: 'url',
                example: '/api/convert?url=https://youtu.be/VIDEO_ID&start=0:30:00&end=1:00:00&title=sermon_title&makeMp4=1',
                note: 'start, end, title, makeMp4는 선택사항입니다. 빈 값이면 전체 영상을 추출하고 YouTube 제목을 사용합니다.'
            });
        }

        // 내부 extract-mp3 API 호출
        return handleMp3Extraction(req, res, {
            youtubeUrl: url,
            startTime: start,
            endTime: end,
            title: title,
            makeMp4: ['1', 'true', 'yes'].includes(String(makeMp4 || '').toLowerCase())
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 외부 API - POST 요청으로도 지원 - 개선된 버전
app.post('/api/convert', async (req, res) => {
    try {
        const { url, start, end, title, makeMp4 } = req.body;

        // URL만 필수, 나머지는 선택사항
        if (!url) {
            return res.status(400).json({
                error: 'YouTube URL이 필요합니다.',
                required: 'url',
                example: '{"url": "https://youtu.be/VIDEO_ID", "start": "0:30:00", "end": "1:00:00", "title": "sermon_title", "makeMp4": true}',
                note: 'start, end, title, makeMp4는 선택사항입니다. 빈 값이면 전체 영상을 추출하고 YouTube 제목을 사용합니다.'
            });
        }

        return handleMp3Extraction(req, res, {
            youtubeUrl: url,
            startTime: start,
            endTime: end,
            title: title,
            makeMp4: !!makeMp4
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

// 종합 헬스체크 엔드포인트
app.get('/api/health', async (req, res) => {
    const mem = process.memoryUsage();
    const activeBackgroundJobs = Array.from(backgroundJobs.values()).filter(j => j.status === 'processing').length;
    const activeSieunJobs = Array.from(sieunJobs.values()).filter(j => j.status === 'processing').length;
    let sseConnections = 0;
    progressTrackers.forEach(conns => { sseConnections += conns.length; });
    sieunJobs.forEach(job => { if (job.listeners) sseConnections += job.listeners.length; });

    // Supabase 연결 체크 (circuit breaker 경유)
    let supabaseStatus = 'unknown';
    if (!circuitBreakers.supabase.isAvailable()) {
        supabaseStatus = 'circuit_open';
    } else {
        try {
            const { error } = await supabase.from('serm').select('count', { count: 'exact', head: true });
            supabaseStatus = error ? 'error' : 'connected';
            if (error) circuitBreakers.supabase.recordFailure();
            else circuitBreakers.supabase.recordSuccess();
        } catch {
            supabaseStatus = 'error';
            circuitBreakers.supabase.recordFailure();
        }
    }

    // yt-dlp 설치 여부
    const ytdlpOk = await checkYtDlp();

    const healthy = supabaseStatus === 'connected' && ytdlpOk;
    const statusCode = healthy ? 200 : 503;

    res.status(statusCode).json({
        status: healthy ? 'healthy' : 'degraded',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: {
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
            rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
        },
        dependencies: {
            supabase: supabaseStatus,
            ytdlp: ytdlpOk ? 'installed' : 'missing',
        },
        jobs: {
            background: { active: activeBackgroundJobs, total: backgroundJobs.size },
            sieun: { active: activeSieunJobs, total: sieunJobs.size },
            sse_connections: sseConnections,
        },
        circuit_breakers: {
            grok: circuitBreakers.grok.getStatus(),
            whisper: circuitBreakers.whisper.getStatus(),
            supabase: circuitBreakers.supabase.getStatus(),
        }
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
    const connections = progressTrackers.get(jobId);
    // SSE 연결 제한 - 초과시 가장 오래된 연결 종료
    while (connections.length >= CONFIG.MAX_SSE_PER_JOB) {
        const oldest = connections.shift();
        try { oldest.end(); } catch(e) {}
    }
    connections.push(res);

    // 타임아웃
    const sseTimeout = setTimeout(() => {
        try { res.end(); } catch(e) {}
    }, CONFIG.SSE_TIMEOUT);

    // heartbeat
    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch(e) { clearInterval(heartbeat); }
    }, CONFIG.SSE_HEARTBEAT_INTERVAL);

    // 클라이언트 연결 해제 시 정리
    req.on('close', () => {
        clearTimeout(sseTimeout);
        clearInterval(heartbeat);
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

        const failed = [];
        connections.forEach((res, index) => {
            try {
                res.write(message);
            } catch (error) {
                log.error('SSE', `전송 오류: ${error.message}`);
                failed.push(index);
            }
        });
        for (let i = failed.length - 1; i >= 0; i--) connections.splice(failed[i], 1);
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
            log.error('Supabase', `연결 오류: ${error.message}`);
            circuitBreakers.supabase.recordFailure();
            return false;
        }
        log.info('Supabase', '연결 성공');
        circuitBreakers.supabase.recordSuccess();
        return true;
    } catch (error) {
        log.error('Supabase', `연결 테스트 실패: ${error.message}`);
        circuitBreakers.supabase.recordFailure();
        return false;
    }
}

// 간단 토큰 추정치(문자 기반 휴리스틱)
function estimateTokens(text) {
    if (!text) return 0;
    // 한글 포함 일반 휴리스틱: 1 토큰 ≈ 3~4자 → 3로 가정(보수적)
    return Math.ceil(text.length / 3);
}

// 텍스트를 목표 토큰 근처로 나누기(문단 기준 → 문자 기준 보강)
function splitIntoChunks(text, targetTokensPerChunk) {
    const paragraphs = (text || '').split(/\n\n+/);
    const chunks = [];
    let buf = '';
    let bufTokens = 0;
    const maxTokens = Math.max(500, targetTokensPerChunk);
    for (const p of paragraphs) {
        const candidate = buf ? buf + '\n\n' + p : p;
        const candTokens = estimateTokens(candidate);
        if (candTokens > maxTokens && buf) {
            chunks.push(buf);
            buf = p;
            bufTokens = estimateTokens(buf);
        } else {
            buf = candidate;
            bufTokens = candTokens;
        }
    }
    if (buf) chunks.push(buf);
    // 만약 문단 기준이 너무 커서 여전히 큼 → 문자 길이로 추가 분할
    const final = [];
    for (const c of chunks) {
        if (estimateTokens(c) <= maxTokens) { final.push(c); continue; }
        const approxChars = maxTokens * 3; // 토큰→문자 환산
        for (let i = 0; i < c.length; i += approxChars) {
            final.push(c.slice(i, i + approxChars));
        }
    }
    return final;
}

async function callAIChat(model, systemPrompt, userPrompt, maxTokens, temperature) {
    if (!circuitBreakers.grok.isAvailable()) {
        throw new Error('Grok API 서킷 브레이커 OPEN - 잠시 후 재시도해주세요');
    }
    const modelsToTry = Array.isArray(model) ? model : [model];
    const sequence = modelsToTry.concat(AI_MODEL_FALLBACKS.filter(m => !modelsToTry.includes(m)));
    let lastErr;
    for (const m of sequence) {
        try {
            log.info('Grok', `모델 시도: ${m} (max_tokens=${maxTokens}, temp=${temperature})`);
            const resp = await axios.post(`${AI_API_BASE_URL}/chat/completions`, {
                model: m,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: maxTokens,
                temperature
            }, {
                headers: {
                    'Authorization': `Bearer ${AI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: CONFIG.AI_API_TIMEOUT
            });
            const data = resp.data;
            const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
            log.info('Grok', `모델 성공: ${m}, 출력 길이: ${content.length}`);
            circuitBreakers.grok.recordSuccess();
            return content;
        } catch (e) {
            circuitBreakers.grok.recordFailure();
            if (e.response) {
                log.warn('Grok', `모델 실패: ${m} → ${e.response.status} ${e.response.statusText}`);
                log.error('Grok', `오류 세부정보: ${JSON.stringify(e.response.data, null, 2)}`);
                lastErr = new Error(`Grok API 오류: ${e.response.status} ${e.response.data?.error?.message || e.response.statusText}`);
                if (e.response.status === 404 || String(e.response.data?.error?.message || '').includes('model_not_found')) {
                    continue;
                }
            } else {
                log.error('Grok', `네트워크 오류: ${e.message}`);
                lastErr = e;
            }
            continue;
        }
    }
    throw lastErr || new Error('모든 모델 시도 실패');
}

// Grok API 연결 테스트
async function testGrokAPI() {
    try {
        log.info('Grok', 'API 연결 테스트 시작...');
        const result = await callAIChat(['grok-3'], '간단히 답변해주세요.', '안녕하세요', 50, 0.3);
        log.info('Grok', `API 연결 테스트 성공: ${result.substring(0, 100)}`);
    } catch (error) {
        log.error('Grok', `API 연결 테스트 실패: ${error.message}`);
        log.info('Grok', '템플릿 모드로 동작합니다.');
    }
}

// ==================== 시은이 API 엔드포인트들 ====================

// 시은이 비디오 처리 API
app.post('/api/sieun/process', multerUpload.single('video'), async (req, res) => {
    const jobId = Date.now().toString();
    
    try {
        if (!req.file) {
            return res.status(400).json({ error: '비디오 파일이 필요합니다.' });
        }

        const activeSieunJobs = Array.from(sieunJobs.values()).filter(j => j.status === 'processing').length;
        if (activeSieunJobs >= CONFIG.MAX_CONCURRENT_SIEUN) {
            return res.status(429).json({ error: `동시 처리 가능한 작업이 초과되었습니다. 잠시 후 다시 시도해주세요. (최대 ${CONFIG.MAX_CONCURRENT_SIEUN}개)` });
        }

        console.log(`시은이 처리 시작: ${req.file.originalname} (Job ID: ${jobId})`);
        
        // 백그라운드 작업으로 등록
        enforceJobLimit(sieunJobs, CONFIG.MAX_JOBS);
        sieunJobs.set(jobId, {
            status: 'processing',
            filename: req.file.originalname,
            startTime: new Date()
        });

        // 즉시 응답
        res.json({
            success: true,
            jobId: jobId,
            message: '비디오 처리가 시작되었습니다.',
            progressUrl: `/api/sieun/progress/${jobId}`
        });

        // 백그라운드에서 처리 시작
        processSieunVideo(jobId, req.file);

    } catch (error) {
        console.error('시은이 처리 오류:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 시은이 진행상황 SSE 엔드포인트
app.get('/api/sieun/progress/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    // 연결 확인
    res.write(`data: ${JSON.stringify({ type: 'connected', jobId })}\n\n`);

    // 진행상황 추적에 추가
    if (!sieunJobs.has(jobId)) {
        sieunJobs.set(jobId, { listeners: [] });
    }
    
    const job = sieunJobs.get(jobId);
    if (!job.listeners) job.listeners = [];
    // SSE 연결 제한
    while (job.listeners.length >= CONFIG.MAX_SSE_PER_JOB) {
        const oldest = job.listeners.shift();
        try { oldest.end(); } catch(e) {}
    }
    job.listeners.push(res);

    // 타임아웃
    const sseTimeout = setTimeout(() => {
        try { res.end(); } catch(e) {}
    }, CONFIG.SSE_TIMEOUT);

    // heartbeat
    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch(e) { clearInterval(heartbeat); }
    }, CONFIG.SSE_HEARTBEAT_INTERVAL);

    // 연결 해제 시 정리
    req.on('close', () => {
        clearTimeout(sseTimeout);
        clearInterval(heartbeat);
        if (sieunJobs.has(jobId)) {
            const job = sieunJobs.get(jobId);
            if (job.listeners) {
                const index = job.listeners.indexOf(res);
                if (index > -1) {
                    job.listeners.splice(index, 1);
                }
            }
        }
    });
});

// 시은이 히스토리 조회 API
app.get('/sieun-index', async (req, res) => {
    try {
        const files = fs.readdirSync(sieunDir);
        // sieun_{ts}_{basename}.* 묶기
        const groups = new Map();
        files.forEach(name => {
            const m = name.match(/^sieun_(\d+)_(.+)\.(mp3|mp4|en\.txt|ko\.txt|en\.md|ko\.md)$/);
            if (!m) return;
            const ts = m[1];
            const base = m[2];
            const key = `${ts}_${base}`;
            if (!groups.has(key)) groups.set(key, { timestamp: Number(ts), baseName: base });
            const g = groups.get(key);
            if (name.endsWith('.mp4')) g.mp4 = `/sieun/${name}`;
            if (name.endsWith('.mp3')) g.mp3 = `/sieun/${name}`;
            if (name.endsWith('.en.txt') || name.endsWith('.en.md')) g.english = `/sieun/${name}`;
            if (name.endsWith('.ko.txt') || name.endsWith('.ko.md')) g.korean = `/sieun/${name}`;
        });
        const items = Array.from(groups.entries())
            .map(([key, value]) => ({ key, ...value }))
            .sort((a,b)=>b.timestamp-a.timestamp);
        res.json({ success: true, items });
    } catch (error) {
        console.error('로컬 히스토리 인덱스 오류:', error);
        res.status(500).json({ success: false, error: 'index error' });
    }
});

// 시은이 결과 저장 API
app.post('/api/sieun/save', async (req, res) => {
    try {
        const result = await saveSieunHistory(req.body);
        
        if (result) {
            res.json({ success: true, id: result.id });
        } else {
            res.json({ success: false, message: 'DB 저장 실패' });
        }

    } catch (error) {
        console.error('저장 오류:', error);
        res.status(500).json({ error: '저장 중 오류가 발생했습니다.' });
    }
});

// 시은이 히스토리 삭제 API
app.delete('/api/sieun/history/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // If id matches local key format (e.g., 1756532933670_2025_08_30 14_48)
        if (/^\d+_.+/.test(id)) {
            const [ts, ...rest] = id.split('_');
            const base = rest.join('_');
            const candidates = [
                path.join(sieunDir, `sieun_${ts}_${base}.mp4`),
                path.join(sieunDir, `sieun_${ts}_${base}.mp3`),
                path.join(sieunDir, `sieun_${ts}_${base}.en.txt`),
                path.join(sieunDir, `sieun_${ts}_${base}.ko.txt`),
                path.join(sieunDir, `sieun_${ts}_${base}.en.md`),
                path.join(sieunDir, `sieun_${ts}_${base}.ko.md`)
            ];
            let deleted = 0;
            for (const fp of candidates) {
                try {
                    if (fs.existsSync(fp)) {
                        fs.unlinkSync(fp);
                        deleted++;
                    }
                } catch {}
            }
            return res.json({ success: true, deleted });
        }

        // Otherwise delete from Supabase DB as before
        if (supabaseUrl === 'your-supabase-url' || supabaseKey === 'your-supabase-anon-key') {
            return res.json({ success: false, message: 'DB 설정 없음' });
        }

        const { error } = await supabase
            .from('sieun_history')
            .delete()
            .eq('id', id);

        if (error) throw error;

        res.json({ success: true });

    } catch (error) {
        console.error('삭제 오류:', error);
        res.status(500).json({ error: '삭제 중 오류가 발생했습니다.' });
    }
});

// 시은이 백그라운드 처리 함수
async function processSieunVideo(jobId, file) {
    try {
        const tempDir = path.join(__dirname, 'sieun', 'temp');
        const mp3Dir = path.join(__dirname, 'sieun');
        
        // 디렉토리 생성
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const inputPath = file.path;
        const baseName = path.parse(file.originalname).name;
        const ts = Date.now();
        const mp3FileName = `sieun_${ts}_${baseName}.mp3`;
        const mp3Path = path.join(mp3Dir, mp3FileName);
        const srcMp4Path = path.join(mp3Dir, `sieun_${ts}_${baseName}.mp4`);
        const engTxtPath = path.join(mp3Dir, `sieun_${ts}_${baseName}.en.md`);
        const korTxtPath = path.join(mp3Dir, `sieun_${ts}_${baseName}.ko.md`);

        // 원본 mp4 보관
        try {
            fs.copyFileSync(inputPath, srcMp4Path);
        } catch (e) {
            console.log('MP4 보관 복사 실패:', e.message);
        }

        // 1단계: MP4 → MP3 변환
        broadcastSieunProgress(jobId, { 
            type: 'mp3_conversion', 
            message: 'MP3 변환 중...' 
        });

        await convertMP4ToMP3(inputPath, mp3Path);

        // 2단계: 영어 음성인식
        broadcastSieunProgress(jobId, { 
            type: 'speech_recognition', 
            message: '영어 음성인식 중...' 
        });

        const englishText = await transcribeAudio(mp3Path);
        try { fs.writeFileSync(engTxtPath, englishText, 'utf8'); } catch(e) { console.log('영어 텍스트 저장 실패:', e.message); }

        // 3단계: 한글 번역
        broadcastSieunProgress(jobId, { 
            type: 'translation', 
            message: '한글 번역 중...' 
        });

        const koreanText = await translateToKorean(englishText);
        try { fs.writeFileSync(korTxtPath, koreanText, 'utf8'); } catch(e) { console.log('한글 텍스트 저장 실패:', e.message); }

        // 완료
        const result = {
            originalFilename: file.originalname,
            englishText: englishText,
            koreanText: koreanText,
            mp3FilePath: `/sieun/${mp3FileName}`,
            mp4FilePath: `/sieun/${path.basename(srcMp4Path)}`,
            englishFilePath: `/sieun/${path.basename(engTxtPath)}`,
            koreanFilePath: `/sieun/${path.basename(korTxtPath)}`
        };


        broadcastSieunProgress(jobId, { 
            type: 'completed', 
            message: '처리 완료!',
            result: result
        });

        // 임시 파일 정리
        try {
            fs.unlinkSync(inputPath);
        } catch (e) {
            console.log('임시 파일 삭제 실패:', e.message);
        }

        // 작업 정리
        setTimeout(() => {
            sieunJobs.delete(jobId);
        }, CONFIG.JOB_CLEANUP_DELAY);

    } catch (error) {
        console.error('시은이 처리 오류:', error);
        broadcastSieunProgress(jobId, { 
            type: 'error', 
            message: error.message 
        });
        
        // 임시 파일 정리
        try {
            if (file.path) fs.unlinkSync(file.path);
        } catch (e) {
            console.log('임시 파일 삭제 실패:', e.message);
        }
    }
}

// 시은이 진행상황 브로드캐스트
function broadcastSieunProgress(jobId, data) {
    if (sieunJobs.has(jobId)) {
        const job = sieunJobs.get(jobId);
        if (job.listeners) {
            const message = `data: ${JSON.stringify(data)}\n\n`;

            const failed = [];
            job.listeners.forEach((res, index) => {
                try {
                    res.write(message);
                } catch (error) {
                    log.error('SSE', `전송 오류: ${error.message}`);
                    failed.push(index);
                }
            });
            for (let i = failed.length - 1; i >= 0; i--) job.listeners.splice(failed[i], 1);
        }
    }
}

// ============================================================
// MP4 요약 파이프라인
// ============================================================

// --- MP4 레코드 저장 (Supabase 우선, 실패 시 mp4/index.json 로컬 폴백) ---
function readMp4Index() {
    try {
        if (fs.existsSync(MP4_INDEX_PATH)) {
            const raw = fs.readFileSync(MP4_INDEX_PATH, 'utf-8');
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        }
    } catch (e) {
        log.warn('MP4', `index.json 읽기 실패: ${e.message}`);
    }
    return [];
}

function writeMp4Index(arr) {
    try {
        fs.writeFileSync(MP4_INDEX_PATH, JSON.stringify(arr, null, 2));
    } catch (e) {
        log.warn('MP4', `index.json 쓰기 실패: ${e.message}`);
    }
}

async function mp4CreateRecord(fields) {
    const row = { ...fields, created_at: new Date().toISOString() };
    try {
        const { data, error } = await supabase.from('mp4_summary').insert([row]).select();
        if (error) throw error;
        return { id: data[0].id, storage: 'supabase' };
    } catch (e) {
        log.warn('MP4', `Supabase insert 실패 → 로컬 폴백: ${e.message}`);
        const idx = readMp4Index();
        const id = Date.now();
        idx.unshift({ id, ...row });
        writeMp4Index(idx);
        return { id, storage: 'local' };
    }
}

async function mp4UpdateRecord(ref, fields) {
    if (!ref) return;
    if (ref.storage === 'supabase') {
        try {
            const { error } = await supabase.from('mp4_summary').update(fields).eq('id', ref.id);
            if (error) throw error;
            return;
        } catch (e) {
            log.warn('MP4', `Supabase update 실패(무시): ${e.message}`);
            return;
        }
    }
    // 로컬 폴백 업데이트
    const idx = readMp4Index();
    const i = idx.findIndex(r => String(r.id) === String(ref.id));
    if (i >= 0) idx[i] = { ...idx[i], ...fields };
    else idx.unshift({ id: ref.id, ...fields });
    writeMp4Index(idx);
}

// --- ffprobe로 미디어 길이(초) 조회 ---
function getMediaDurationSec(filePath) {
    return new Promise((resolve) => {
        const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        p.stdout.on('data', d => out += d.toString());
        p.on('close', () => { const v = parseFloat(out.trim()); resolve(isNaN(v) ? 0 : v); });
        p.on('error', () => resolve(0));
    });
}

// --- FFmpeg 실행 래퍼 ---
function runFfmpeg(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let stderr = '';
        p.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 100000) stderr = stderr.slice(-100000); });
        const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} reject(new Error('FFmpeg 타임아웃')); }, timeoutMs || CONFIG.FFMPEG_TIMEOUT);
        p.on('close', c => { clearTimeout(to); c === 0 ? resolve() : reject(new Error(`FFmpeg 실패(코드:${c}) ${stderr.slice(-300)}`)); });
        p.on('error', e => { clearTimeout(to); reject(e); });
    });
}

// --- Whisper verbose_json 업로드 (세그먼트 + 단어 타임스탬프) ---
async function uploadChunkVerbose(filePath, apiKey, language) {
    const FormData = require('form-data');
    if (!circuitBreakers.whisper.isAvailable()) {
        throw new Error('Whisper API 서킷 브레이커 OPEN - 잠시 후 재시도해주세요');
    }
    let lastErr;
    for (let i = 0; i < 3; i++) {
        try {
            const formData = new FormData();
            formData.append('file', fs.createReadStream(filePath));
            formData.append('model', 'whisper-1');
            formData.append('response_format', 'verbose_json');
            formData.append('timestamp_granularities[]', 'segment');
            formData.append('timestamp_granularities[]', 'word');
            if (language) formData.append('language', language);
            const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
                headers: { Authorization: `Bearer ${apiKey}`, ...formData.getHeaders() },
                maxBodyLength: Infinity,
                timeout: 300000
            });
            circuitBreakers.whisper.recordSuccess();
            return response.data || {};
        } catch (e) {
            circuitBreakers.whisper.recordFailure();
            lastErr = e;
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
        }
    }
    throw lastErr || new Error('whisper verbose upload 실패');
}

// --- 타임스탬프 STT: 세그먼트/단어 배열 반환 (청크 오프셋 누적) ---
async function transcribeWithTimestamps(audioPath) {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey || apiKey === 'your-openai-api-key') {
        throw new Error('OpenAI API 키가 설정되지 않았습니다.');
    }
    let preparedAudio = null;
    const segments = [];
    const words = [];
    try {
        preparedAudio = await prepareAudioForWhisper(audioPath);
        const chunks = preparedAudio.files;
        let offset = 0; // 청크 시작 시각 누적 오프셋(초)
        for (let i = 0; i < chunks.length; i++) {
            const chunkDur = await getMediaDurationSec(chunks[i]);
            log.info('STT-TS', `청크 ${i + 1}/${chunks.length} (offset=${offset.toFixed(1)}s)`);
            const data = await uploadChunkVerbose(chunks[i], apiKey, 'ko');
            const segs = Array.isArray(data.segments) ? data.segments : [];
            for (const s of segs) {
                // no_speech_prob > 0.6 세그먼트(침묵/환각)는 후보에서 제외
                if (typeof s.no_speech_prob === 'number' && s.no_speech_prob > 0.6) continue;
                const text = (s.text || '').trim();
                if (!text) continue;
                segments.push({ start: (s.start || 0) + offset, end: (s.end || 0) + offset, text, no_speech_prob: s.no_speech_prob });
            }
            const wds = Array.isArray(data.words) ? data.words : [];
            for (const w of wds) {
                const word = (w.word || w.text || '').trim();
                if (!word) continue;
                words.push({ start: (w.start || 0) + offset, end: (w.end || 0) + offset, word });
            }
            offset += chunkDur;
        }
        segments.sort((a, b) => a.start - b.start);
        words.sort((a, b) => a.start - b.start);
        return { segments, words };
    } finally {
        if (preparedAudio && preparedAudio.cleanup) preparedAudio.cleanup();
    }
}

// --- LLM JSON 파싱 헬퍼(코드펜스/잡음 제거) ---
function parseLlmJson(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    const cb = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (cb) s = cb[1].trim();
    const fb = s.indexOf('{'), lb = s.lastIndexOf('}');
    const fa = s.indexOf('['), la = s.lastIndexOf(']');
    if (fb !== -1 && lb > fb && (fa === -1 || fb < fa)) s = s.substring(fb, lb + 1);
    else if (fa !== -1 && la > fa) s = s.substring(fa, la + 1);
    try { return JSON.parse(s); } catch (e) { return null; }
}

function secToMMSS(sec) {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
}

// --- 한국어 문장 완결 여부 (블록 경계용) ---
function endsWithCompleteSentence(text) {
    const t = (text || '').trim();
    if (!t) return false;
    if (/[.?!…]["'”’]?$/.test(t)) return true; // 구두점으로 끝남
    // 구두점이 없어도 종결어미로 끝나면 완결로 간주
    return /(습니다|입니다|합니다|됩니다|겠습니다|하세요|십시오|시다|잖아요|거든요|네요|지요|죠|까요|나요|아멘)$/.test(t);
}

// --- 세그먼트를 ~20-40초 블록으로 병합 (문장 완결 경계 우선) ---
// words: word 타임스탬프 배열(선택) — Whisper가 찬양/음악 구간에서 수 분짜리 초장문 세그먼트를
// 반환하는 경우가 있어, hardMax 초과 세그먼트는 단어 단위로 잘게 쪼갠다 (블록이 거칠어지면 모든 가드가 무뎌짐)
function buildBlocks(segments, minSec = 20, maxSec = 40, hardMaxSec = 55, words = null) {
    const expanded = [];
    for (const seg of segments || []) {
        const dur = (seg.end || 0) - (seg.start || 0);
        const text = (seg.text || '').trim();
        if (!text) continue;
        if (dur <= hardMaxSec) { expanded.push(seg); continue; }
        const pieces = Math.max(2, Math.ceil(dur / 35));
        const ws = (words || []).filter(w => w.start >= seg.start - 0.5 && w.end <= seg.end + 0.5);
        if (ws.length >= pieces * 3) {
            const per = Math.ceil(ws.length / pieces);
            for (let i = 0; i < ws.length; i += per) {
                const grp = ws.slice(i, i + per);
                expanded.push({ start: grp[0].start, end: grp[grp.length - 1].end, text: grp.map(w => w.word).join(' ').replace(/\s+/g, ' ').trim() });
            }
        } else {
            // 단어 정보가 부족하면 시간·텍스트 비례 분할
            const step = dur / pieces;
            const tstep = Math.ceil(text.length / pieces);
            for (let k = 0; k < pieces; k++) {
                const t = text.slice(tstep * k, tstep * (k + 1)).trim();
                if (t) expanded.push({ start: seg.start + step * k, end: Math.min(seg.end, seg.start + step * (k + 1)), text: t });
            }
        }
    }
    segments = expanded;

    const blocks = [];
    let cur = null;
    for (const seg of segments) {
        const text = (seg.text || '').trim();
        if (!text) continue;
        if (!cur) { cur = { start: seg.start, end: seg.end, text }; continue; }
        const curLen = cur.end - cur.start;
        const wouldLen = seg.end - cur.start;
        // 문장이 완결된 상태에서만 블록을 닫는다. 단, hardMax를 넘기면 강제로 닫음(문장 중간 컷 방지 유예 한도)
        const shouldClose =
            (curLen >= minSec && endsWithCompleteSentence(cur.text)) ||
            (wouldLen > maxSec && endsWithCompleteSentence(cur.text)) ||
            curLen >= hardMaxSec;
        if (shouldClose) {
            blocks.push(cur);
            cur = { start: seg.start, end: seg.end, text };
        } else {
            cur.end = seg.end;
            cur.text += ' ' + text;
        }
    }
    if (cur) blocks.push(cur);
    return blocks.map((b, i) => ({ i, start: b.start, end: b.end, text: b.text }));
}

// --- 긴 텍스트 앞/중간/뒤 샘플링(구조 분석용) ---
function condenseText(t, cap) {
    if (!t || t.length <= cap) return t || '';
    const head = Math.floor(cap * 0.4), tail = Math.floor(cap * 0.4), mid = cap - head - tail;
    const ms = Math.max(0, Math.floor(t.length / 2 - mid / 2));
    return t.slice(0, head) + '\n...(중략)...\n' + t.slice(ms, ms + mid) + '\n...(중략)...\n' + t.slice(t.length - tail);
}

// --- word-level 타임스탬프로 클립 경계 패딩 ---
function padClip(startSec, endSec, words, minBound, maxBound) {
    let s = startSec, e = endSec;
    if (words && words.length) {
        const inRange = words.filter(w => w.end > startSec && w.start < endSec);
        if (inRange.length) {
            s = inRange[0].start - 0.25;
            e = inRange[inRange.length - 1].end + 0.45;
        } else { s = startSec - 0.25; e = endSec + 0.45; }
    } else { s = startSec - 0.25; e = endSec + 0.45; }
    s = Math.max(minBound, s);
    e = Math.min(maxBound, e);
    if (e <= s) e = Math.min(maxBound, s + 0.5);
    return { start: s, end: e };
}

// --- 균등 샘플링 폴백 클립 (처음 60초 + 본문 8등분 + 마지막 60초) ---
function fallbackClips(minBound, maxBound, words) {
    const raw = [];
    const introEnd = Math.min(minBound + 60, maxBound);
    raw.push([minBound, introEnd]);
    const bodyStart = introEnd;
    const bodyEnd = Math.max(bodyStart, maxBound - 60);
    const seg = (bodyEnd - bodyStart) / 8;
    if (seg > 4) {
        for (let k = 0; k < 8; k++) {
            const cs = bodyStart + seg * k;
            raw.push([cs, Math.min(cs + 48, bodyEnd)]);
        }
    }
    raw.push([Math.max(minBound, maxBound - 60), maxBound]);
    raw.sort((a, b) => a[0] - b[0]);
    // 병합
    const merged = [];
    for (const [a, b] of raw) {
        const last = merged[merged.length - 1];
        if (last && a - last[1] < 2) last[1] = Math.max(last[1], b);
        else merged.push([a, b]);
    }
    return merged.filter(([a, b]) => b - a >= 8).map(([a, b]) => padClip(a, b, words, minBound, maxBound));
}

// --- 구간 선정용 AI 모델: 복잡한 기획/선정 판단이라 추론형 상위 모델 우선, 실패 시 기본 모델 폴백 ---
const CLIP_AI_MODELS = ['grok-4-0709'];

// --- 블록 클립 정규화 + 병합 시 실제 덩어리 수 계산 (연속 구간 퇴화 감지용) ---
function countMergedClips(rawClips, blocks) {
    const N = blocks.length;
    if (!N) return 0;
    const clamp = (v) => Math.max(0, Math.min(v, N - 1));
    const norm = [];
    for (const c of rawClips || []) {
        const arr = c && c.blocks;
        if (!Array.isArray(arr) || !arr.length) continue;
        let a = clamp(parseInt(arr[0], 10)), b = clamp(parseInt(arr[arr.length - 1], 10));
        if (isNaN(a) || isNaN(b)) continue;
        if (b < a) { const t = a; a = b; b = t; }
        norm.push([a, b]);
    }
    norm.sort((x, y) => x[0] - y[0]);
    let count = 0, lastEnd = -10;
    for (const [a, b] of norm) {
        if (a > lastEnd + 1) count++;
        lastEnd = Math.max(lastEnd, b);
    }
    return count;
}

// --- 코드 차원 구조 보강: AI 선정 결과에 서론/결론/스토리가 빠졌으면 강제로 채움 ---
function enforceStructure(rawClips, blocks, stories) {
    const N = blocks.length;
    if (!N) return rawClips;
    const clamp = (v) => Math.max(0, Math.min(v, N - 1));
    const secOf = (a, b) => blocks[b].end - blocks[a].start;
    let clips = [];
    for (const c of rawClips || []) {
        const arr = c && c.blocks;
        if (!Array.isArray(arr) || !arr.length) continue;
        let a = clamp(parseInt(arr[0], 10)), b = clamp(parseInt(arr[arr.length - 1], 10));
        if (isNaN(a) || isNaN(b)) continue;
        if (b < a) { const t = a; a = b; b = t; }
        clips.push({ blocks: [a, b], part: c.part || '', importance: Number(c.importance) || 3 });
    }
    if (!clips.length) return rawClips;
    // [과대 클립 사전 축소] 300초 초과 클립은 서론/결론 보강 검사 전에 먼저 줄인다
    // (순서 중요: 축소를 나중에 하면 "전체를 덮는 거대 클립" 때문에 결론 보강이 건너뛰어진 후 잘려나감)
    const inStoryES = (idx) => (stories || []).some(st => idx >= st.a && idx <= st.b);
    for (const c of clips) {
        let g = 0;
        const before = secOf(c.blocks[0], c.blocks[1]);
        while (secOf(c.blocks[0], c.blocks[1]) > 300 && g < 400) {
            g++;
            if (c.blocks[1] > c.blocks[0] && !inStoryES(c.blocks[1])) { c.blocks[1]--; continue; }
            if (c.blocks[0] < c.blocks[1] && !inStoryES(c.blocks[0])) { c.blocks[0]++; continue; }
            break;
        }
        if (before !== secOf(c.blocks[0], c.blocks[1])) {
            log.info('MP4', `과대 클립 사전 축소: ${Math.round(before)}초 → ${Math.round(secOf(c.blocks[0], c.blocks[1]))}초`);
        }
    }
    // 식별된 스토리가 어느 클립에도 안 담겼으면 스토리 클립 추가
    for (const st of stories || []) {
        const covered = clips.some(c => c.blocks[0] <= st.b && c.blocks[1] >= st.a);
        if (!covered) clips.push({ blocks: [clamp(st.a), clamp(st.b)], part: '스토리', importance: 5 });
    }
    clips.sort((x, y) => x.blocks[0] - y.blocks[0]);
    // 서론 보강: 첫 클립이 설교 앞 15% 안에서 시작하지 않으면 도입 클립(~60초) 추가
    if (clips[0].blocks[0] > Math.floor(N * 0.15)) {
        let b0 = 0;
        while (b0 < N - 1 && secOf(0, b0) < 60) b0++;
        clips.unshift({ blocks: [0, b0], part: '서론(보강)', importance: 5 });
        log.info('MP4', '구조 보강: 서론 클립 자동 추가');
    }
    // 결론 보강: 마지막 클립이 설교 뒤 15% 안에서 끝나지 않으면 결론 클립(~75초) 추가
    if (clips[clips.length - 1].blocks[1] < N - 1 - Math.floor(N * 0.15)) {
        let a1 = N - 1;
        while (a1 > 0 && secOf(a1, N - 1) < 75) a1--;
        clips.push({ blocks: [a1, N - 1], part: '결론(보강)', importance: 5 });
        log.info('MP4', '구조 보강: 결론 클립 자동 추가');
    }
    return clips;
}

// --- 블록 인덱스 클립 → 초 단위 클립 (스토리 보호/정렬/병합/최소길이/총길이 조정/패딩) ---
function postProcessBlockClips(rawClips, blocks, words, minBound, maxBound, stories = []) {
    if (!blocks.length) return [];
    const clamp = (v) => Math.max(0, Math.min(v, blocks.length - 1));
    let clips = [];
    for (const c of rawClips || []) {
        let arr = c && c.blocks;
        if (!Array.isArray(arr) || !arr.length) continue;
        let a = clamp(arr[0]);
        let b = clamp(arr[arr.length - 1]);
        if (b < a) { const t = a; a = b; b = t; }
        clips.push({ a, b, part: c.part || '', importance: Number(c.importance) || 3 });
    }
    if (!clips.length) return [];
    // [스토리 통째 보장] 스토리 범위와 부분적으로 겹치는 클립은 스토리 전체를 포함하도록 확장 (AI가 실수해도 코드가 보정)
    for (const st of stories || []) {
        for (const c of clips) {
            if (c.a <= st.b && c.b >= st.a) {
                c.a = Math.min(c.a, clamp(st.a));
                c.b = Math.max(c.b, clamp(st.b));
                c.story = true;
            }
        }
    }
    clips.sort((x, y) => x.a - y.a);
    // 인접/겹침 병합 (블록 인접 또는 간격 < 2초)
    const merged = [];
    for (const c of clips) {
        const last = merged[merged.length - 1];
        if (last && (c.a <= last.b + 1 || blocks[c.a].start - blocks[last.b].end < 2)) {
            last.b = Math.max(last.b, c.b);
            last.importance = Math.max(last.importance, c.importance);
            last.story = last.story || c.story;
        } else merged.push({ ...c });
    }
    clips = merged;
    const clipSec = (c) => blocks[c.b].end - blocks[c.a].start;
    // 최소 8초 미만 제거
    clips = clips.filter(c => clipSec(c) >= 8);
    if (!clips.length) return [];
    // [과대 클립 방어] 단일 클립 300초 초과 시 문장(블록) 경계에서 축소 — 스토리 범위는 침범하지 않음
    // (하드캡이 클립 중간을 뚝 자르는 것보다 문장 완결 지점에서 줄이는 것이 우선)
    const inStory = (idx) => (stories || []).some(st => idx >= st.a && idx <= st.b);
    for (const c of clips) {
        let g1 = 0;
        const beforeSec = clipSec(c);
        while (clipSec(c) > 300 && g1 < 400) {
            g1++;
            if (c.b > c.a && !inStory(c.b)) { c.b--; continue; }
            if (c.a < c.b && !inStory(c.a)) { c.a++; continue; }
            break;
        }
        if (beforeSec !== clipSec(c)) log.info('MP4', `과대 클립 축소: ${Math.round(beforeSec)}초 → ${Math.round(clipSec(c))}초`);
    }
    let total = clips.reduce((s, c) => s + clipSec(c), 0);
    // 590초 초과 → 1차: 스토리/서론/결론 제외한 클립을 importance 낮은 순으로 제거
    if (total > 590) {
        const removable = clips.map((c, idx) => ({ idx, c })).filter(o => o.idx !== 0 && o.idx !== clips.length - 1 && !o.c.story).sort((p, q) => p.c.importance - q.c.importance);
        for (const o of removable) {
            if (total <= 570) break;
            total -= clipSec(o.c);
            o.c._remove = true;
        }
        clips = clips.filter(c => !c._remove);
        // 2차: 여전히 초과면 비스토리 클립(마지막 클립 제외)의 끝을 블록 단위로 축소 (문장 경계 유지, 스토리는 절대 축소 안 함)
        total = clips.reduce((s, c) => s + clipSec(c), 0);
        let g2 = 0;
        while (total > 590 && g2 < 300) {
            g2++;
            let cand = null;
            for (let ci = 0; ci < clips.length - 1; ci++) {
                const c = clips[ci];
                if (c.story || c.b <= c.a) continue;
                if (!cand || clipSec(c) > clipSec(cand)) cand = c;
            }
            if (!cand) break;
            cand.b--;
            total = clips.reduce((s, c) => s + clipSec(c), 0);
        }
        clips = clips.filter(c => clipSec(c) >= 8);
    }
    // 340초 미만 → 인접 블록으로 확장 (6분 미만으로 너무 짧을 때만)
    total = clips.reduce((s, c) => s + clipSec(c), 0);
    let guard = 0;
    while (total < 340 && guard < 500) {
        guard++;
        let expanded = false;
        for (let ci = 0; ci < clips.length; ci++) {
            const c = clips[ci];
            const next = clips[ci + 1];
            const prev = clips[ci - 1];
            if (c.b + 1 <= blocks.length - 1 && (!next || c.b + 1 < next.a)) { c.b++; expanded = true; }
            else if (c.a - 1 >= 0 && (!prev || c.a - 1 > prev.b)) { c.a--; expanded = true; }
            total = clips.reduce((s, cc) => s + clipSec(cc), 0);
            if (total >= 420) break;
        }
        if (!expanded) break;
    }
    // 초 변환 + word 패딩 + 클램프
    let out = clips.map(c => padClip(blocks[c.a].start, blocks[c.b].end, words, minBound, maxBound));
    // 최종 하드캡: 원칙 600초, 단 마지막 클립(결론/스토리)이 중간에 잘리는 것을 막기 위해 630초까지 완결 허용
    let acc = 0;
    const capped = [];
    for (const c of out) {
        const d = c.end - c.start;
        if (acc + d > 600) {
            if (acc + d <= 630) { capped.push(c); acc += d; break; } // 살짝 초과는 완결 우선
            const remain = 600 - acc;
            if (remain >= 8) capped.push({ start: c.start, end: c.start + remain });
            break;
        }
        capped.push(c);
        acc += d;
    }
    return capped;
}

// --- 예전(禮典) 블록 휴리스틱: 찬양대/헌금/봉독/반복 가사 등 감지 (구간 머리/꼬리 정리용) ---
function isLiturgyBlock(text) {
    const t = text || '';
    if (/찬양대|성가대|헌금|봉헌|십일조|축도|대독|봉독|교회 소식|알림광고|모임광고|새가족/.test(t)) return true;
    // 반복 가사(노래) 감지: 고유 단어 비율이 낮으면 노래로 간주
    const w = t.split(/\s+/).filter(Boolean);
    if (w.length >= 20) {
        const uniq = new Set(w).size;
        if (uniq / w.length < 0.4) return true;
    }
    return false;
}

// --- Pass 0: 설교 본문 구간 식별 (광고/찬양/기도 등 비설교 블록을 후보에서 원천 제거) ---
async function detectSermonRange(blocks) {
    const list = blocks.map(b => `#${b.i} [${secToMMSS(b.start)}] ${b.text.slice(0, 100)}`).join('\n');
    const sys = '당신은 예배 영상 분석가다. 반드시 JSON만 출력하라.';
    const user = `아래는 예배 실황 자막 블록 목록이다. 설교자가 성경 말씀을 강해하는 "설교 본문"이 시작되는 블록 번호(sermonStart)와 끝나는 블록 번호(sermonEnd)를 찾아라.

주의:
- 찬양/특송에 대한 소감, 교회 소식·광고, 새가족 소개·환영과 그를 위한 기도, 대표기도, 헌금 안내와 헌금 기도, 찬양대(성가대) 찬양 가사, 성경 봉독(대독), 축도, 인사말은 설교가 아니다. 설교자가 직접 말하더라도 광고·소개·환영·기도·봉독은 설교 본문이 아니다.
- 성경 봉독 → 헌금 기도 → 찬양대 찬양 순서가 설교 직전에 이어지는 경우가 많다. sermonStart는 이런 예전 순서가 모두 끝나고 설교자가 본문 강해(해설)를 실제로 시작하는 블록이어야 한다.
- 설교는 마무리 권면·기도로 끝난다. 그 뒤의 축도·광고는 제외하라.

출력 JSON: {"sermonStart": 블록번호, "sermonEnd": 블록번호}

블록 목록:
${list}`;
    const res = parseLlmJson(await callAIChat([...CLIP_AI_MODELS, AI_MODEL], sys, user, 400, 0.2));
    if (!res) return null;
    let s = parseInt(res.sermonStart, 10);
    let e = parseInt(res.sermonEnd, 10);
    if (isNaN(s) || isNaN(e)) { log.warn('MP4', `설교 구간 응답 형식 오류: ${JSON.stringify(res).slice(0, 200)}`); return null; }
    // 모델이 번호를 살짝 벗어나게 주는 경우가 있어 거부하지 않고 경계로 클램프
    s = Math.max(0, Math.min(s, blocks.length - 1));
    e = Math.max(0, Math.min(e, blocks.length - 1));
    if (e < s) { const t = s; s = e; e = t; }
    if (e - s < 5) return null; // 너무 좁으면 오탐으로 보고 전체 사용
    return { start: s, end: e };
}

// --- 발췌 구간 선정: 4-pass 에이전트 (설교구간 식별 → Planner → Selector → Reviewer) ---
// verifyFeedback: 자체 검증 루프에서 불합격 시 전달되는 보완 지시 (Selector 프롬프트에 반영)
async function selectSummaryClips(segments, words, jobId, targetSec = 480, minBound = 0, maxBound = 0, verifyFeedback = '') {
    const allBlocks = buildBlocks(segments, 20, 40, 55, words);
    if (!allBlocks.length) return fallbackClips(minBound, maxBound, words);

    // Pass 0 - 설교 본문 구간 식별: 범위 밖 블록(광고/찬양/기도 등)은 후보에서 제거
    let blocks = allBlocks;
    try {
        broadcastProgress(jobId, { type: 'progress', stage: 'detecting', message: '설교 구간 식별 중(1/4)...', progress: 61 });
        let range = await detectSermonRange(allBlocks);
        if (!range) range = await detectSermonRange(allBlocks); // 1회 재시도
        let rs = range ? range.start : 0;
        let re = range ? range.end : allBlocks.length - 1;
        if (!range) log.warn('MP4', '설교 구간 식별 실패 → 전체 블록 사용');
        // 코드 휴리스틱: 구간 머리/꼬리의 예전 블록(찬양대/헌금/봉독/반복 가사)을 기계적으로 제거 (AI 오판 방어)
        const maxTrim = Math.floor((re - rs + 1) * 0.4);
        let headTrim = 0, tailTrim = 0;
        while (rs < re && headTrim < maxTrim && isLiturgyBlock(allBlocks[rs].text)) { rs++; headTrim++; }
        while (re > rs && tailTrim < maxTrim && isLiturgyBlock(allBlocks[re].text)) { re--; tailTrim++; }
        if (headTrim || tailTrim) log.info('MP4', `예전 블록 정리: 머리 ${headTrim}개, 꼬리 ${tailTrim}개 제거`);
        blocks = allBlocks.slice(rs, re + 1).map((b, i2) => ({ ...b, i: i2 }));
        log.info('MP4', `설교 구간 확정: 블록 #${rs}~#${re} (${secToMMSS(allBlocks[rs].start)} ~ ${secToMMSS(allBlocks[re].end)}), 전체 ${allBlocks.length}개 중 ${blocks.length}개 사용`);
    } catch (e) {
        log.warn('MP4', `설교 구간 식별 오류(전체 블록 사용): ${e.message}`);
    }
    const fullText = blocks.map(b => b.text).join(' ');

    try {
        const clampIdx = (v) => Math.max(0, Math.min(v, blocks.length - 1));
        // 블록 목록(텍스트 120자 절단)
        const blockList = blocks.map(b => `#${b.i} [${secToMMSS(b.start)}] ${b.text.slice(0, 120)}`).join('\n');

        // Pass 1 - 기획(Planner): 전체 자막 블록을 직접 검토해 발췌 기획안 작성
        broadcastProgress(jobId, { type: 'progress', stage: 'planning', message: 'AI 기획 중(2/4)...', progress: 63 });
        const plannerSys = '당신은 설교 영상 편집 기획자다. 전체 자막을 먼저 검토하여 요약 영상에 추출할 부분의 기획안을 작성한다. 반드시 JSON만 출력하라.';
        const plannerUser = `아래 설교 자막 블록 전체를 분석해 발췌 요약 기획안을 작성하라.

기획 원칙:
- 서론-본론-결론 구조가 잘 드러나도록 각 부분에서 추출할 블록 구간을 계획하라.
- 요약에 꼭 담을 만한 대표 스토리(예화, 간증, 개인 일화)를 최대 3개까지 찾아 blocks 범위로 표시하라. 스토리는 중간에 잘라내면 안 되는 한 덩어리다(시작~끝 전체).
- 스토리는 보통 1~4분 내외의 완결된 일화다. 성경 본문 강해·해설·설명 자체를 스토리로 표시해서는 절대 안 된다.
- 설교를 처음 듣는 사람도 흐름을 이해할 수 있게, 논지의 맥락이 자연스럽게 이어지도록 계획하라.

출력 JSON:
{"theme":"설교 핵심 주제 한 문장",
 "stories":[{"about":"무슨 이야기인지 한 줄","blocks":[시작블록i,끝블록i]}],
 "outline":[{"part":"서론|본론1|본론2|결론","message":"핵심 메시지","blocks":[시작블록i,끝블록i],"importance":1-5}]}

블록 목록:
${blockList}`;
        let plan = parseLlmJson(await callAIChat([...CLIP_AI_MODELS, AI_MODEL], plannerSys, plannerUser, 2500, 0.3));
        if (!plan) plan = parseLlmJson(await callAIChat([...CLIP_AI_MODELS, AI_MODEL], plannerSys, plannerUser, 2500, 0.3));
        const outline = (plan && Array.isArray(plan.outline)) ? plan.outline : [];
        // 스토리 범위 정규화 (코드 차원 스토리 보호에 사용)
        let stories = (plan && Array.isArray(plan.stories) ? plan.stories : []).map(s => {
            const arr = s && s.blocks;
            if (!Array.isArray(arr) || !arr.length) return null;
            let a = clampIdx(parseInt(arr[0], 10)), b = clampIdx(parseInt(arr[arr.length - 1], 10));
            if (isNaN(a) || isNaN(b)) return null;
            if (b < a) { const t = a; a = b; b = t; }
            return { a, b, about: s.about || '' };
        }).filter(Boolean);
        // [스토리 과대 식별 방어] 개별 240초 초과 스토리는 보호 제외, 보호 총량은 360초까지만
        // (설교 대부분을 "스토리"로 지정하면 통째 보호가 요약을 집어삼켜 하드캡 절단이 발생하는 것 방지)
        const storyDur = (s) => blocks[s.b].end - blocks[s.a].start;
        const storyCountBefore = stories.length;
        stories = stories.filter(s => storyDur(s) <= 240);
        stories.sort((x, y) => storyDur(x) - storyDur(y));
        const keptStories = [];
        let protectedTotal = 0;
        for (const s of stories) {
            if (protectedTotal + storyDur(s) > 360) break;
            keptStories.push(s);
            protectedTotal += storyDur(s);
        }
        stories = keptStories.sort((x, y) => x.a - y.a);
        if (storyCountBefore !== stories.length) {
            log.info('MP4', `스토리 보호 필터: ${storyCountBefore}개 → ${stories.length}개 (개별≤240초, 총량≤360초)`);
        }
        if (stories.length) log.info('MP4', `기획: 스토리 ${stories.length}개 보호 - ${stories.map(s => `#${s.a}~#${s.b}(${Math.round(storyDur(s))}초)`).join(', ')}`);

        // Pass 2 - 선정(Selector)
        broadcastProgress(jobId, { type: 'progress', stage: 'selecting', message: '구간 선정 중(3/4)...', progress: 66 });
        const selectorSys = '당신은 설교 영상 편집자다. 기획안(outline/stories)에 따라 추출할 블록 구간을 선정한다. 초 단위 시간이 아니라 반드시 블록 인덱스(#숫자)만 사용하라. 반드시 JSON만 출력하라.';
        const selectorUser = `설교 주제: ${plan && plan.theme ? plan.theme : ''}\n기획안 구조(outline):\n${JSON.stringify(outline)}\n스토리 목록(잘라내기 금지 덩어리):\n${JSON.stringify(stories.map(s => ({ about: s.about, blocks: [s.a, s.b] })))}\n\n규칙(반드시 준수):\n- [절대 금지] 비설교 블록 포함 금지: 찬양/특송/가사, 교회 소식·광고, 새가족 소개·환영·기도, 대표기도, 헌금 안내, 축도, 인사말 등.\n- [스토리 통째 규칙] 스토리 목록의 범위와 겹치는 클립은 그 스토리의 시작~끝 블록 전체를 포함해야 한다. 스토리를 중간에 자르는 것은 절대 금지. 넣거나(전체) 빼거나(전체) 둘 중 하나다.\n- [끊김 금지] 하나의 이야기·논증이 클립 경계에서 끊기면 안 된다. 각 클립은 완결된 문장으로 시작해 완결된 문장으로 끝나야 한다.\n- [이해 우선] 설교를 처음 듣는 사람도 이해할 수 있도록, 논지에 필요한 맥락(성경 본문 소개, 이야기의 배경)을 함께 포함하라.\n- 첫 클립은 설교의 실제 서론, 마지막 클립은 설교 결론부(마무리·적용·권면)여야 한다.\n- [몽타주 원칙] 요약은 설교 전체에서 고르게 발췌한 몽타주다. 클립 수는 4~7개, 각 클립은 30~120초(스토리 포함 클립만 예외적으로 더 길게 허용). 클립들은 서로 떨어진 구간이어야 하며, 설교 전체나 절반 이상을 하나의 연속 구간으로 선정하는 것은 절대 금지.\n- 총 길이 ${targetSec - 120}~${targetSec + 90}초(블록 시간 기준) 목표. 단, 스토리 완결과 흐름의 자연스러움이 길이보다 우선이다.\n- 시간순 정렬.${verifyFeedback ? `\n\n[이전 시도 검증 불합격 — 반드시 반영할 보완 지시]\n${verifyFeedback}` : ''}\n\n출력 JSON: {"clips":[{"blocks":[시작블록i, 끝블록i],"reason":"어느 outline 항목","part":"서론","importance":1-5}]}\n\n블록 목록:\n${blockList}`;
        let selRes = parseLlmJson(await callAIChat([...CLIP_AI_MODELS, AI_MODEL], selectorSys, selectorUser, 2000, 0.3));
        if (!selRes) selRes = parseLlmJson(await callAIChat([...CLIP_AI_MODELS, AI_MODEL], selectorSys, selectorUser, 2000, 0.3));
        let rawClips = (selRes && Array.isArray(selRes.clips)) ? selRes.clips : null;
        if (!rawClips || !rawClips.length) return fallbackClips(minBound, maxBound, words);

        // [클립 수/연속 구간 퇴화 방어] 병합해보면 사실상 1~2덩어리인 선정은 재선정 1회 요청
        // (클립을 여러 개 반환해도 전부 인접 구간이면 통짜 연속 구간과 같음)
        if (countMergedClips(rawClips, blocks) < 3) {
            log.warn('MP4', `Selector 선정이 사실상 ${countMergedClips(rawClips, blocks)}덩어리 (몽타주 규칙 위반) → 재선정 요청`);
            const retryUser = selectorUser + `\n\n[재선정 지시] 직전 선정은 클립들이 사실상 연속된 1~2개 덩어리라 몽타주 원칙 위반이다. 설교 전체에 걸쳐 서로 떨어진 위치(서론, 본론의 여러 지점, 결론)에서 4~7개의 클립(각 30~120초)을 선정해 같은 JSON 형식으로 다시 출력하라.`;
            const retryRes = parseLlmJson(await callAIChat([...CLIP_AI_MODELS, AI_MODEL], selectorSys, retryUser, 2000, 0.3));
            if (retryRes && Array.isArray(retryRes.clips) && countMergedClips(retryRes.clips, blocks) >= 3) {
                rawClips = retryRes.clips;
                log.info('MP4', `재선정 채택: ${rawClips.length}개 클립`);
            }
        }

        // Pass 3 - 검증/조정(Reviewer): rubric 기반, 최대 2회
        for (let attempt = 0; attempt < 2; attempt++) {
            broadcastProgress(jobId, { type: 'progress', stage: 'reviewing', message: `검토 중(4/4, ${attempt + 1})...`, progress: 68 });
            const preview = rawClips.map((c, k) => {
                const a = clampIdx((c.blocks || [0])[0]);
                const b = clampIdx((c.blocks || [0])[(c.blocks || [0]).length - 1]);
                const secs = Math.round(blocks[b].end - blocks[a].start);
                return `클립${k + 1}[${c.part || ''}, ~${secs}초]: ${blocks[a].text.slice(0, 60)} ... ${blocks[b].text.slice(0, 60)}`;
            }).join('\n');
            const totalSec = Math.round(rawClips.reduce((s, c) => {
                const a = clampIdx((c.blocks || [0])[0]);
                const b = clampIdx((c.blocks || [0])[(c.blocks || [0]).length - 1]);
                return s + (blocks[b].end - blocks[a].start);
            }, 0));
            const reviewerSys = '당신은 설교 영상 편집 감수자다. rubric으로 편집안을 평가하고 필요 시 블록 인덱스를 수정한다. 반드시 JSON만 출력하라.';
            const reviewerUser = `현재 총 길이: ${totalSec}초\n스토리 목록(잘라내기 금지 덩어리):\n${JSON.stringify(stories.map(s => ({ about: s.about, blocks: [s.a, s.b] })))}\n편집안(클립 순서대로):\n${preview}\n\nrubric 7항목을 평가하라:\n1) 비설교 콘텐츠(찬양/특송, 교회 소식·광고, 새가족 소개, 대표기도, 헌금, 축도)가 포함되지 않았는가 — 하나라도 있으면 불합격\n2) 첫 클립이 설교의 실제 서론인가 (예배 앞부분 광고·소개·기도면 불합격)\n3) 마지막 클립이 설교 결론부(마무리·적용·권면)인가 (본론 중간 설명으로 끝나면 불합격)\n4) [스토리 통째] 스토리 목록과 겹치는 클립이 그 스토리 전체(시작~끝)를 포함하는가 — 스토리가 중간에 잘리면 불합격\n5) [끊김 없음] 각 클립이 완결된 문장으로 시작·끝나고, 이야기·논증이 중간에 끊기지 않는가\n6) 처음 듣는 사람도 이해할 수 있게 흐름이 자연스럽고 서론-본론-결론과 핵심 메시지가 드러나는가\n7) 총 길이가 360~570초 범위인가 (길이는 유연 — 스토리 완결이 길이보다 우선)\n\n모두 충족하면 {"ok":true}만, 아니면 {"ok":false,"clips":[{"blocks":[시작i,끝i],"part":"...","importance":1-5}]} 형식으로 수정본을 출력하라. 블록 인덱스(#숫자)만 사용.`;
            const rev = parseLlmJson(await callAIChat([...CLIP_AI_MODELS, AI_MODEL], reviewerSys, reviewerUser, 2000, 0.3));
            if (!rev) break;
            if (rev.ok === true) break;
            // [수정안 검증] 클립을 3개 미만으로 줄이는 수정안은 거부하고 기존 선정안 유지
            if (Array.isArray(rev.clips) && rev.clips.length >= 3) rawClips = rev.clips;
            else {
                if (Array.isArray(rev.clips)) log.warn('MP4', `Reviewer 수정안 거부 (클립 ${rev.clips.length}개 < 3)`);
                break;
            }
        }

        // 코드 차원 구조 보강 (서론/결론/스토리 누락 시 강제 채움)
        rawClips = enforceStructure(rawClips, blocks, stories);

        const finalClips = postProcessBlockClips(rawClips, blocks, words, minBound, maxBound, stories);
        if (!finalClips.length) return fallbackClips(minBound, maxBound, words);
        return finalClips;
    } catch (e) {
        log.warn('MP4', `구간 선정 실패, 균등 샘플링 폴백: ${e.message}`);
        return fallbackClips(minBound, maxBound, words);
    }
}

// --- 클립별 재인코딩(페이드 포함) 후 concat 병합 ---
async function cutAndConcatClips(originalPath, clips, outputPath, tempFiles, jobId) {
    const tmpDir = path.join(__dirname, 'uploads', 'temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const uid = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const partPaths = [];
    for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        const dur = Math.max(0.5, c.end - c.start);
        const fadeOutStart = Math.max(0, dur - 0.2);
        const partPath = path.join(tmpDir, `${uid}_part_${String(i).padStart(3, '0')}.mp4`);
        partPaths.push(partPath);
        tempFiles.push(partPath);
        const vf = `fade=t=in:st=0:d=0.2,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.2`;
        const af = `afade=t=in:st=0:d=0.2,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.2`;
        // -ss는 -i 앞(빠른 탐색) + -t 정밀 길이, 클립마다 동일 파라미터로 재인코딩
        await runFfmpeg([
            '-y',
            '-ss', c.start.toFixed(3),
            '-i', originalPath,
            '-t', dur.toFixed(3),
            '-vf', vf,
            '-af', af,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
            '-avoid_negative_ts', 'make_zero',
            '-movflags', '+faststart',
            partPath
        ], CONFIG.FFMPEG_TIMEOUT);
        broadcastProgress(jobId, { type: 'progress', stage: 'editing', message: `영상 편집 중... (${i + 1}/${clips.length})`, progress: Math.min(72 + Math.round((i + 1) / clips.length * 16), 88) });
    }
    // concat demuxer 목록 (동일 파라미터이므로 -c copy 가능)
    const listPath = path.join(tmpDir, `${uid}_list.txt`);
    tempFiles.push(listPath);
    const listContent = partPaths.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent);
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', outputPath], CONFIG.FFMPEG_TIMEOUT);
    if (!fs.existsSync(outputPath)) throw new Error('요약 MP4 병합 실패');
}

// --- YouTube 자동 업로드 (환경변수 미설정 시 스킵) ---
async function uploadToYouTube(filePath, { title, description }) {
    const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN, YOUTUBE_PRIVACY_STATUS } = CONFIG;
    if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
        log.info('YouTube', '환경변수 미설정 - 업로드 스킵');
        return { skipped: true };
    }
    const oauth2 = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, 'http://localhost:8089/callback');
    oauth2.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
    const youtube = google.youtube({ version: 'v3', auth: oauth2 });
    const resp = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
            snippet: { title: `${title} (요약)`.substring(0, 100), description: description || '', categoryId: '22' },
            status: { privacyStatus: YOUTUBE_PRIVACY_STATUS || 'unlisted' }
        },
        media: { body: fs.createReadStream(filePath) }
    });
    return { videoId: resp.data && resp.data.id };
}

// --- 본문(bonmun)을 요약하지 않고 정리한 마크다운 생성 ---
async function organizeBonmunToHtml(jemok, bonmun) {
    const text = (bonmun || '').trim();
    if (!text) return '';
    if (!AI_API_KEY) return text; // AI 미설정 시 원문 폴백
    const sys = '너는 한국어 설교 원고 정리 편집자다. 주어진 음성인식(STT) 자막을 요약하지 말고 그대로 정리하라. 오탈자와 음성인식 오류를 교정하고, 자연스럽게 문단을 나누고 소제목(## 형식)을 붙여라. 내용을 절대 축약하거나 삭제하지 말고 모든 내용을 보존하라. 출력은 순수 마크다운만.';
    try {
        const chunks = splitTextIntoChunks(text, 4000);
        const parts = [];
        for (let i = 0; i < chunks.length; i++) {
            const user = `다음은 설교 "${jemok}"의 자막 일부(${i + 1}/${chunks.length})다. 요약하지 말고 오류 교정과 문단/소제목 정리만 하라:\n\n${chunks[i]}`;
            const r = await callAIChat([AI_MODEL], sys, user, 4000, 0.2);
            parts.push((r || '').trim() || chunks[i]);
        }
        return parts.join('\n\n');
    } catch (e) {
        log.warn('HTML정리', `AI 정리 실패, 원문 사용: ${e.message}`);
        return text;
    }
}

// --- 스탠드얼론 HTML 문서 템플릿 ---
function buildStandaloneHtml(jemok, bodyHtml, dateStr) {
    const safeTitle = escapeTelegramHtml(jemok);
    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle} - 설교정리</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&family=Noto+Serif+KR:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Noto Serif KR', serif; line-height: 1.9; color: #1f2937; max-width: 820px; margin: 0 auto; padding: 48px 24px 96px; background: #fff; }
  header { border-bottom: 3px solid #1e3a5f; padding-bottom: 16px; margin-bottom: 32px; }
  header h1 { font-family: 'Noto Sans KR', sans-serif; font-size: 28px; font-weight: 700; color: #1e3a5f; margin: 0 0 8px; }
  header .date { font-family: 'Noto Sans KR', sans-serif; font-size: 14px; color: #6b7280; }
  h2 { font-family: 'Noto Sans KR', sans-serif; font-size: 21px; font-weight: 700; color: #1e3a5f; margin: 36px 0 12px; padding-left: 10px; border-left: 5px solid #2563eb; }
  h3 { font-family: 'Noto Sans KR', sans-serif; font-size: 18px; font-weight: 600; color: #374151; margin: 24px 0 10px; }
  p { margin: 0 0 16px; text-align: justify; }
  ul, ol { margin: 0 0 16px; padding-left: 24px; }
  li { margin-bottom: 6px; }
  blockquote { border-left: 4px solid #cbd5e1; margin: 16px 0; padding: 8px 18px; color: #475569; background: #f8fafc; }
  strong { color: #1e3a5f; }
  @media print {
    body { padding: 0; max-width: none; }
    h2 { break-after: avoid; }
  }
</style>
</head>
<body>
<header>
  <h1>${safeTitle}</h1>
  ${dateStr ? `<div class="date">${escapeTelegramHtml(dateStr)}</div>` : ''}
</header>
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

// --- 요약본 자체 검증 1: 요약 mp4 → 오디오 추출 → Whisper 전사 (평문) ---
async function transcribeSummaryPlain(summaryPath, tempFiles) {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey || apiKey === 'your-openai-api-key') throw new Error('OpenAI API 키 미설정');
    const tmpDir = path.join(__dirname, 'uploads', 'temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const audioPath = path.join(tmpDir, `verify_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.mp3`);
    tempFiles.push(audioPath);
    execSync(`ffmpeg -y -loglevel error -i "${summaryPath}" -vn -ac 1 -ar 16000 -b:a 48k "${audioPath}"`, { timeout: CONFIG.FFMPEG_TIMEOUT, windowsHide: true });
    return await uploadChunkToWhisper(audioPath, apiKey, 'ko');
}

// --- 요약본 자체 검증 2: 전사 텍스트를 rubric으로 평가 (하네스 검증 루프의 자동화) ---
async function verifySummaryQuality(transcript) {
    const sys = '당신은 설교 요약 영상 품질 검수자다. 반드시 JSON만 출력하라.';
    const user = `아래는 설교 요약 영상(발췌 몽타주)의 전체 전사다. rubric 4항목으로 평가하라.

rubric:
1) 시작이 설교 내용(서론·주제 소개·본문 배경)인가 — 찬양 가사, 교회 소식·광고, 새가족 소개, 대표기도, 헌금, 성경 봉독 낭독으로 시작하면 불합격
2) 끝이 설교 마무리(권면·축원·마무리 기도)로 완결된 문장으로 끝나는가 — 문장 중간에 끊기거나, 전환 멘트(예: "~절 말씀 같이 보시겠습니다"), 찬양 안내로 끝나면 불합격
3) 중간에 비설교 콘텐츠(찬양 가사 반복, 헌금 안내, 광고, 새가족 소개)가 섞여 있지 않은가
4) 서론-본론-결론 흐름이 느껴지고 설교의 핵심 메시지가 전달되는가

출력 JSON: {"pass": true|false, "issues": ["불합격 사유 요약"], "feedback": "재선정 시 반영할 구체적 지시 1~3문장"}

전사:
${(transcript || '').slice(0, 12000)}`;
    const res = parseLlmJson(await callAIChat([...CLIP_AI_MODELS, AI_MODEL], sys, user, 800, 0.2));
    if (!res || typeof res.pass !== 'boolean') {
        log.warn('MP4', '자체 검증 응답 파싱 실패 → 통과 처리');
        return { pass: true, issues: [], feedback: '' };
    }
    return { pass: res.pass, issues: Array.isArray(res.issues) ? res.issues : [], feedback: res.feedback || '' };
}

// --- MP4 요약 백그라운드 파이프라인 ---
async function processMp4SummaryInBackground(jobId, { youtubeUrl, startTime, endTime, title, summaryId }) {
    let ref = null;
    const tempFiles = [];
    let originalPath = null;
    let summaryPath = null;
    const isFullVideo = !startTime || !endTime || String(startTime).trim() === '' || String(endTime).trim() === '';
    let finalTitle = title;
    // 제목 미지정 시 YouTube 제목 자동 추출 (MP3 경로와 동일한 동작)
    if (!finalTitle || String(finalTitle).trim() === '') {
        try { finalTitle = await getYouTubeTitle(youtubeUrl); } catch (e) { log.warn('MP4', `제목 추출 실패: ${e.message}`); }
    }
    finalTitle = finalTitle || 'sermon';
    const cleanTitle = (finalTitle || '').replace(/^\d+[_-]*/, '');
    try {
        broadcastProgress(jobId, { type: 'started', stage: 'initializing', message: 'MP4 요약 준비 중...', progress: 0 });
        ref = await mp4CreateRecord({ title: cleanTitle, youtube_url: youtubeUrl, status: 'processing', summary_id: summaryId || null });

        // 1) 원본 MP4 다운로드
        broadcastProgress(jobId, { type: 'progress', stage: 'downloading', message: '원본 영상 다운로드 중...', progress: 5 });
        const sanitized = (finalTitle || 'sermon').replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);
        const baseName = `${Date.now()}_${sanitized}`;
        originalPath = path.join(mp4Dir, `${baseName}.mp4`);
        const baseArgs = [
            '--legacy-server-connect', '--no-check-certificate', '--force-ipv4',
            '--add-header', 'Accept-Language:en-US,en;q=0.9', '--add-header', 'Sec-Fetch-Mode:navigate',
            '--extractor-args', 'youtube:player_client=default'
        ];
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(cookiesPath)) baseArgs.push('--cookies', cookiesPath);
        const dlArgs = [
            ...baseArgs,
            '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b',
            '--merge-output-format', 'mp4',
            '--progress', '--newline',
            '-o', originalPath
        ];
        if (!isFullVideo) {
            dlArgs.push('--download-sections', `*${startTime}-${endTime}`, '--force-keyframes-at-cuts');
        }
        dlArgs.push(youtubeUrl);
        await runYtdlp(dlArgs, jobId, CONFIG.YTDLP_TIMEOUT);
        if (!fs.existsSync(originalPath)) throw new Error('원본 MP4 다운로드 실패');
        const originalDuration = await getMediaDurationSec(originalPath);
        await mp4UpdateRecord(ref, { original_file: path.basename(originalPath), duration_sec: Math.round(originalDuration) });

        // 2) 타임스탬프 STT
        broadcastProgress(jobId, { type: 'progress', stage: 'transcribing', message: '음성 분석(STT) 중...', progress: 42 });
        const { segments, words } = await transcribeWithTimestamps(originalPath);
        if (!segments.length) throw new Error('STT 세그먼트를 얻지 못했습니다.');

        // 3~4) 발췌 선정 → 편집 → 자체 검증 루프 (하네스 방식 자동화, 최대 2회 시도)
        summaryPath = path.join(mp4Dir, `${baseName}_요약.mp4`);
        const VERIFY_MAX_ATTEMPTS = 2;
        let verifyResult = { pass: true, issues: [], feedback: '' };
        let verifyFeedback = '';
        let usedAttempts = 1;
        for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt++) {
            usedAttempts = attempt;
            const clips = await selectSummaryClips(segments, words, jobId, 480, 0, originalDuration, verifyFeedback);
            if (!clips.length) throw new Error('발췌 구간 선정 실패');
            log.info('MP4', `[시도 ${attempt}] 선정 클립 ${clips.length}개, 총 ${Math.round(clips.reduce((s, c) => s + (c.end - c.start), 0))}초`);

            broadcastProgress(jobId, { type: 'progress', stage: 'editing', message: `영상 편집 중(시도 ${attempt})...`, progress: 72 });
            await cutAndConcatClips(originalPath, clips, summaryPath, tempFiles, jobId);

            // 자체 검증: 결과물을 전사해서 rubric 평가 (실패해도 파이프라인은 계속)
            broadcastProgress(jobId, { type: 'progress', stage: 'verifying', message: `요약 자체 검증 중(시도 ${attempt})...`, progress: 84 });
            try {
                const transcript = await transcribeSummaryPlain(summaryPath, tempFiles);
                verifyResult = await verifySummaryQuality(transcript);
            } catch (e) {
                log.warn('MP4', `자체 검증 오류(통과 처리): ${e.message}`);
                verifyResult = { pass: true, issues: [], feedback: '' };
            }
            if (verifyResult.pass) {
                log.info('MP4', `[시도 ${attempt}] 자체 검증 통과`);
                break;
            }
            log.warn('MP4', `[시도 ${attempt}] 자체 검증 불합격: ${verifyResult.issues.join(' / ')}`);
            if (attempt < VERIFY_MAX_ATTEMPTS) {
                verifyFeedback = `${verifyResult.issues.join('; ')}${verifyResult.feedback ? ' — ' + verifyResult.feedback : ''}`;
                safeUnlink(summaryPath);
            }
        }
        const verifyNote = verifyResult.pass
            ? (usedAttempts === 1 ? '검증 통과' : `보완 후 통과 (${usedAttempts}회 시도)`)
            : `검증 미흡 — ${verifyResult.issues.slice(0, 2).join(' / ')}`;
        const summaryDuration = await getMediaDurationSec(summaryPath);
        await mp4UpdateRecord(ref, { summary_file: path.basename(summaryPath), summary_duration_sec: Math.round(summaryDuration) });

        // 5) YouTube 업로드
        broadcastProgress(jobId, { type: 'progress', stage: 'uploading', message: 'YouTube 업로드 중...', progress: 92 });
        let youtubeVideoId = null;
        try {
            const up = await uploadToYouTube(summaryPath, { title: cleanTitle, description: `설교 요약 영상\n원본: ${youtubeUrl}` });
            if (up && up.videoId) {
                youtubeVideoId = up.videoId;
                await mp4UpdateRecord(ref, { youtube_video_id: youtubeVideoId });
            }
        } catch (e) {
            log.warn('YouTube', `업로드 실패(파이프라인 계속): ${e.message}`);
            await mp4UpdateRecord(ref, { youtube_error: e.message });
        }

        // 6) 완료
        await mp4UpdateRecord(ref, { status: 'completed' });
        const summaryMp4Url = `/mp4/${encodeURIComponent(path.basename(summaryPath))}`;
        const originalMp4Url = `/mp4/${encodeURIComponent(path.basename(originalPath))}`;
        const youtubeVideoUrl = youtubeVideoId ? `https://youtu.be/${youtubeVideoId}` : undefined;
        broadcastProgress(jobId, { type: 'completed', stage: 'finished', message: 'MP4 요약이 완료되었습니다!', progress: 100, summaryMp4Url, originalMp4Url, youtubeVideoUrl });
        backgroundJobs.set(jobId, { ...(backgroundJobs.get(jobId) || {}), status: 'completed', endTime: new Date() });

        // Telegram 완료 알림
        const nowStr = new Date().toLocaleTimeString('ko-KR', { hour12: false });
        const dlBase = CONFIG.PUBLIC_BASE_URL || '';
        const sumLink = dlBase + summaryMp4Url;
        const ytLine = youtubeVideoUrl ? `▶ YouTube: ${escapeTelegramHtml(youtubeVideoUrl)}\n` : '';
        const successText =
            `✅ <b>MP4 요약 완료</b>\n\n` +
            `📝 제목: ${escapeTelegramHtml(cleanTitle)}\n` +
            `⏱ 길이: ${Math.floor(summaryDuration / 60)}분 ${Math.round(summaryDuration % 60)}초\n` +
            `📋 자체 검증: ${escapeTelegramHtml(verifyNote)}\n` +
            `🎬 <a href="${sumLink}">요약 영상 보기</a>\n` +
            ytLine +
            `\n🕐 ${nowStr}`;
        notifyTelegram(successText).catch(e => log.error('Telegram', `MP4 완료 알림 실패: ${e.message}`));

        setTimeout(() => { progressTrackers.delete(jobId); backgroundJobs.delete(jobId); }, CONFIG.JOB_CLEANUP_DELAY);
    } catch (error) {
        log.error('MP4', `처리 실패: ${error.message}`);
        if (ref) { try { await mp4UpdateRecord(ref, { status: 'failed', error: error.message }); } catch (e) {} }
        broadcastProgress(jobId, { type: 'error', stage: 'failed', message: 'MP4 요약 처리 중 오류가 발생했습니다.', error: error.message });
        backgroundJobs.set(jobId, { ...(backgroundJobs.get(jobId) || {}), status: 'error', endTime: new Date() });

        const nowStr = new Date().toLocaleTimeString('ko-KR', { hour12: false });
        const errorText =
            `❌ <b>MP4 요약 실패</b>\n\n` +
            `📝 제목: ${escapeTelegramHtml(cleanTitle)}\n` +
            `🔗 원본: ${escapeTelegramHtml(youtubeUrl)}\n` +
            `⚠ 오류: ${escapeTelegramHtml(error.message)}\n\n` +
            `🕐 ${nowStr}`;
        notifyTelegram(errorText).catch(e => log.error('Telegram', `MP4 실패 알림 실패: ${e.message}`));
    } finally {
        tempFiles.forEach(f => safeUnlink(f));
    }
}

// ==================== MP4 요약 API 엔드포인트 ====================

// MP4 요약 생성 트리거
app.post('/api/mp4-summary', async (req, res) => {
    try {
        const { url, start, end, title, summaryId } = req.body || {};
        if (!url) return res.status(400).json({ error: 'YouTube URL이 필요합니다.' });
        if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: '유효한 YouTube URL이 아닙니다.' });
        if ((start && !isValidTimeFormat(start)) || (end && !isValidTimeFormat(end))) {
            return res.status(400).json({ error: '시간 형식이 올바르지 않습니다. HH:MM:SS 형식을 사용해주세요.' });
        }

        const jobId = 'mp4_' + Date.now();
        broadcastProgress(jobId, { type: 'started', stage: 'initializing', message: 'MP4 요약 준비 중...', progress: 0 });

        enforceJobLimit(backgroundJobs, CONFIG.MAX_JOBS);
        backgroundJobs.set(jobId, { status: 'processing', kind: 'mp4-summary', title: title || '', startTime: new Date() });

        res.status(202).json({
            success: true,
            jobId,
            message: 'MP4 요약 생성이 백그라운드에서 시작되었습니다.',
            progressUrl: `/api/progress/${jobId}`
        });

        processMp4SummaryInBackground(jobId, {
            youtubeUrl: url,
            startTime: start,
            endTime: end,
            title,
            summaryId
        }).catch(e => log.error('MP4', `파이프라인 예외: ${e.message}`));
    } catch (error) {
        console.error('mp4-summary error:', error);
        if (!res.headersSent) res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// MP4 요약 목록 조회
app.get('/api/mp4', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const q = (req.query.q || '').trim();
        const offset = (page - 1) * limit;

        const mapRow = (r) => ({
            id: r.id,
            title: r.title || '',
            created_at: r.created_at,
            original_file: r.original_file || null,
            summary_file: r.summary_file || null,
            original_url: r.original_file ? `/mp4/${encodeURIComponent(r.original_file)}` : null,
            summary_url: r.summary_file ? `/mp4/${encodeURIComponent(r.summary_file)}` : null,
            duration_sec: r.duration_sec || null,
            summary_duration_sec: r.summary_duration_sec || null,
            youtube_video_id: r.youtube_video_id || null,
            youtube_url: r.youtube_url || null,
            status: r.status || 'processing',
            error: r.error || null
        });

        try {
            let query = supabase.from('mp4_summary').select('*', { count: 'exact' }).order('created_at', { ascending: false });
            if (q) {
                const eq = escapeIlike(q);
                query = query.or(`title.ilike.%${eq}%`);
            }
            query = query.range(offset, offset + limit - 1);
            const { data, count, error } = await query;
            if (error) throw error;
            return res.json({
                items: (data || []).map(mapRow),
                pagination: { currentPage: page, totalPages: Math.ceil((count || 0) / limit), totalCount: count || 0 }
            });
        } catch (dbErr) {
            // Supabase 실패 → 로컬 index.json 폴백
            log.warn('MP4', `목록 Supabase 실패 → 로컬 폴백: ${dbErr.message}`);
            let all = readMp4Index();
            if (q) {
                const ql = q.toLowerCase();
                all = all.filter(r => (r.title || '').toLowerCase().includes(ql));
            }
            all.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
            const totalCount = all.length;
            const items = all.slice(offset, offset + limit).map(mapRow);
            return res.json({
                items,
                pagination: { currentPage: page, totalPages: Math.ceil(totalCount / limit), totalCount }
            });
        }
    } catch (error) {
        console.error('mp4 list error:', error);
        res.status(500).json({ error: 'mp4 list error' });
    }
});

// MP4 요약 삭제 (레코드 + 로컬 파일)
app.delete('/api/mp4/:id', async (req, res) => {
    try {
        const { id } = req.params;
        let record = null;
        try {
            const { data } = await supabase.from('mp4_summary').select('*').eq('id', id).single();
            record = data;
        } catch (e) { /* 로컬 폴백에서 조회 */ }
        if (!record) {
            const idx = readMp4Index();
            record = idx.find(r => String(r.id) === String(id)) || null;
        }
        // 로컬 mp4 파일 삭제
        if (record) {
            if (record.original_file) safeUnlink(path.join(mp4Dir, path.basename(record.original_file)));
            if (record.summary_file) safeUnlink(path.join(mp4Dir, path.basename(record.summary_file)));
        }
        // Supabase 레코드 삭제
        try { await supabase.from('mp4_summary').delete().eq('id', id); } catch (e) { /* 무시 */ }
        // 로컬 index 레코드 삭제
        const idx = readMp4Index();
        const filtered = idx.filter(r => String(r.id) !== String(id));
        if (filtered.length !== idx.length) writeMp4Index(filtered);

        res.json({ success: true });
    } catch (error) {
        console.error('mp4 delete error:', error);
        res.status(500).json({ error: 'mp4 delete error' });
    }
});

// 설교 본문을 AI로 정리하여 스탠드얼론 HTML 문서로 다운로드 (PDF 대체)
app.post('/api/summary/:id/html', async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase.from('youtube_summary').select('*').eq('id', id).single();
        if (error || !data) {
            return res.status(404).json({ error: '요약 데이터를 찾을 수 없습니다.' });
        }
        const organizedMd = await organizeBonmunToHtml(data.jemok, data.bonmun);
        const bodyHtml = marked.parse(organizedMd || (data.bonmun || ''));
        const dateStr = data.created_at ? new Date(data.created_at).toLocaleDateString('ko-KR') : '';
        const html = buildStandaloneHtml(data.jemok || '설교', bodyHtml, dateStr);

        const safeTitle = (data.jemok || '설교').replace(/[<>:"/\\|?*]/g, '_');
        const fileName = `${safeTitle}_설교정리.html`;
        const encoded = encodeURIComponent(fileName);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="sermon.html"; filename*=UTF-8''${encoded}`);
        res.send(html);
    } catch (err) {
        console.error('[HTML] 생성 오류:', err);
        if (!res.headersSent) res.status(500).json({ error: 'HTML 생성 중 오류가 발생했습니다.', details: err.message });
    }
});

// ==================== Express Global Error Handler ====================
app.use((err, req, res, next) => {
    log.error('Express', `${req.method} ${req.path} - ${err.message}`, err.stack);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({
        error: '서버 내부 오류가 발생했습니다.',
        ...(CONFIG.LOG_LEVEL === 'debug' ? { details: err.message } : {})
    });
});

// Graceful shutdown 핸들러
let server;
function gracefulShutdown(signal) {
    console.log(`\n${signal} 수신, 서버 종료 중...`);

    // 새 연결 거부
    if (server) {
        server.close(() => {
            console.log('모든 연결이 종료되었습니다.');
            process.exit(0);
        });
    }

    // 진행 중인 SSE 연결 정리
    progressTrackers.forEach((connections, jobId) => {
        connections.forEach(res => {
            try { res.end(); } catch(e) {}
        });
    });
    progressTrackers.clear();

    sieunJobs.forEach((job, jobId) => {
        if (job.listeners) {
            job.listeners.forEach(res => {
                try { res.end(); } catch(e) {}
            });
        }
    });

    // 10초 후 강제 종료
    setTimeout(() => {
        console.error('강제 종료');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server = app.listen(PORT, async () => {
    log.info('Server', `http://localhost:${PORT} 에서 실행 중`);

    // Supabase 연결 테스트
    const isConnected = await testSupabaseConnection();
    if (!isConnected) {
        log.warn('Server', 'Supabase 연결에 문제가 있습니다. 설교 관리 기능이 제한될 수 있습니다.');
    }
    // Grok 모델 설정 로깅
    try {
        log.info('Grok', `기본 모델: ${AI_MODEL}`);
        log.info('Grok', `폴백 시퀀스: ${AI_MODEL_FALLBACKS.join(' -> ')}`);

        // Grok API 연결 테스트
        testGrokAPI();
    } catch {}

    // yt-dlp 자동 업데이트 체크
    try {
        log.info('yt-dlp', '업데이트 확인 중...');
        const updateResult = execSync('yt-dlp -U', { encoding: 'utf-8', timeout: 30000, windowsHide: true });
        const lines = updateResult.trim().split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1] || '';
        log.info('yt-dlp', lastLine);
    } catch (e) {
        log.warn('yt-dlp', `업데이트 확인 실패: ${e.message}`);
    }

    log.info('Server', `웹 브라우저에서 http://localhost:${PORT} 로 접속하세요.`);
});
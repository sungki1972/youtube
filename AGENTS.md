# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

### Development Commands
- `npm start` - Start the production server on port 9897
- `npm run dev` - Start development server with nodemon auto-restart
- `npm run start:pm2` - Start via PM2 process manager

### Background Execution Scripts (Windows)
- `start-background.bat` - CMD: background server with port conflict detection
- `start-background.ps1` - PowerShell: background server with better error handling
- `start-pm2.bat` - PM2 process manager launch with auto-restart
- `stop-server.bat` - Multi-method server termination (PM2 → PID → port → fallback)
- `install.bat` - Automated initial setup (npm install, dependency checks, directory creation)

### External Dependencies Required
- **FFmpeg** - Audio/video processing (`winget install FFmpeg`)
- **yt-dlp** - YouTube video downloading (`pip install yt-dlp`)
- Both must be in system PATH

## Architecture Overview

**설교 관리 시스템** (Sermon Management System) - 한국 교회 설교 YouTube MP3 추출 및 관리 웹 애플리케이션.

### Tech Stack
- **Backend**: Express.js (server.js, ~2,437 lines)
- **Frontend**: Multi-page HTML + TailwindCSS + Feather Icons (~4,000 lines total)
- **Database**: Supabase (PostgreSQL)
- **Audio Processing**: FFmpeg + yt-dlp pipeline
- **AI/STT**: OpenAI Whisper (transcription), Grok API (text analysis/summarization)
- **Translation**: Google Cloud Translate (primary), Grok API (fallback)
- **Real-time**: Server-Sent Events (SSE) for progress tracking

## File Structure

```
├── server.js                  # Main Express server (2,437 lines, all backend logic)
├── package.json               # Dependencies: express, supabase, axios, multer, openai, etc.
├── .env                       # Environment configuration (see env.example)
├── .gitignore                 # Excludes: .env, node_modules, uploads/, *.mp3, *.db
├── public/
│   ├── index.html             # Main UI: YouTube MP3 extraction + sermon board (201 lines)
│   ├── script.js              # Frontend JS for index.html (342 lines)
│   ├── api.html               # Full management UI: MP3변환, 파일목록, SUMMARY, OPENAI 4탭 (1,819 lines)
│   ├── sieun.html             # Mobile-optimized 시은이: MP4→MP3→영어→한국어 (550 lines)
│   ├── sieun.file.html        # 시은이 히스토리 뷰어 with analytics (466 lines)
│   ├── files.html             # MP3 파일 목록 (local + Supabase 통합, 296 lines)
│   └── mp.html                # Android 벨소리 만들기 Intent bridge (125 lines)
├── sieun/                     # 시은이 처리 결과 저장 (mp4, mp3, en.txt, ko.txt per job)
├── uploads/                   # MP3 파일 저장, temp/ 하위 임시 파일
│   └── temp/                  # Temporary processing files
├── youtubemp3/                # YouTube MP3 관련 파일
├── BACKGROUND_RUN.md          # 백그라운드 실행 가이드 (5가지 방법 비교)
├── CRON_JOBS.md               # 예약 작업 구현 가이드
├── DEPLOYMENT.md              # 배포 가이드 (Vercel, Heroku, Docker 등)
├── GROK_AUDIO_ANALYSIS.md     # Grok 오디오 API 조사 결과 (미지원 확인)
└── README.md                  # 프로젝트 개요 및 설치 가이드
```

## Database Schema (Supabase)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `serm` | 설교 레코드 | title, date, mp3_file, txt_file |
| `youtube_summary` | 영상 요약 | jemok, bonmun, youyak |
| `openai_result` | AI 분석 결과 | summary_id, prompt_type, content |
| `sieun_history` | 시은이 처리 이력 | original_filename, english_text, korean_text, mp3_file_path |

## API Endpoints (server.js)

### MP3 Extraction
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/extract-mp3` | YouTube MP3 추출 (시간 범위 지정, SSE 진행률) |
| GET/POST | `/api/convert` | 외부 API용 MP3 변환 |
| GET | `/audio/:filename` | 오디오 스트리밍 (HTTP Range 지원) |

### YouTube Summary CRUD
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/summary` | 목록 조회 (페이징, 검색) |
| POST | `/api/summary` | 새 요약 생성 |
| GET/PUT/DELETE | `/api/summary/:id` | 개별 요약 조회/수정/삭제 |

### OpenAI (Grok) AI Analysis
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/openai-result` | AI 분석 결과 목록 |
| POST | `/api/openai-result` | Grok API로 AI 분석 생성 (5종 프롬프트) |
| GET | `/api/openai-result/:id/prompt` | 사용된 시스템/유저 프롬프트 조회 |
| GET/PUT/DELETE | `/api/openai-result/:id` | 개별 결과 조회/수정/삭제 |

### 시은이 (Sieun) Feature
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sieun/process` | MP4 업로드 → MP3 → 영어 STT → 한국어 번역 |
| GET | `/api/sieun/progress/:jobId` | SSE 실시간 진행률 |
| GET | `/sieun-index` | 로컬 파일 인덱스 조회 |
| POST | `/api/sieun/save` | 처리 이력 Supabase 저장 |
| DELETE | `/api/sieun/history/:id` | 이력 삭제 |

### Monitoring & Utilities
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/progress/:jobId` | MP3 추출 SSE 진행률 |
| GET | `/api/background-jobs` | 전체 백그라운드 작업 상태 |
| GET | `/api/status` | 서버 헬스체크 |
| GET | `/api/files` | 업로드된 MP3 파일 목록 |
| GET | `/api/docs` | API 문서 |

## 외부 트리거 + Telegram 완료 알림

휴대폰에서 키보드 입력 없이 변환을 트리거하고 결과를 받기 위한 워크플로우.

### 트리거: Direct API URL (코드 변경 없이 사용)

PC에서 URL 한 번 만들어 본인 텔레그램·카톡·메모앱에 저장. 휴대폰에서 링크 탭만으로 변환 시작:

```
http://112.223.44.142:9897/api/convert?url=<YOUTUBE_URL>&start=0:30:00&end=1:30:00&title=<제목>
```

- 클라이언트(브라우저)는 즉시 JSON 응답 받고 닫아도 됨
- 변환은 서버의 `processMP3InBackground` (server.js:1282)에서 계속 진행
- `backgroundJobs` Map(server.js:184)으로 상태 관리, 완료 5분 후 자동 정리

### 완료 알림: 서버 사이드 Telegram 훅

어떤 경로(api.html / Direct URL / mp3bot)로 트리거되든 완료/실패 시 단일 진실 공급원으로 발송.

- **헬퍼**: `notifyTelegram(text)` (server.js, `log` 블록 직후)
  - axios POST `https://api.telegram.org/bot<TOKEN>/sendMessage`, 10s timeout, 1회 재시도(3s 백오프)
  - 환경변수 `TELEGRAM_BOT_TOKEN`·`TELEGRAM_CHAT_ID` 둘 다 set일 때만 동작 (opt-in)
  - 실패 시 `console.error`만, 변환 흐름 절대 무차단
  - HTML 이스케이프 헬퍼 `escapeTelegramHtml(s)` 동반
- **호출 지점**: `processMP3InBackground` 완료/catch 분기에서 fire-and-forget (`.catch(console.error)`)
- **메시지 포맷** (HTML, parse_mode=HTML)
  - 성공: ✅ + 파일명/크기/제목/구간/원본URL/`<a>` 다운로드 링크/시각
  - 실패: ❌ + 제목/원본URL/`error.message`/시각
- **다운로드 링크**: `${PUBLIC_BASE_URL}/uploads/${encodeURIComponent(fileName)}`. `host` 헤더 의존 시 LAN/외부 네트워크에 따라 잘못 만들어지므로 명시적 환경변수.

### mp3bot 중복 방지

`mp3bot/telegram_mp3_bot.py:369` `handle_completed`의 `send_message(...)` 호출은 주석 처리됨. 진행 메시지 in-place 정리(`edit_message`)는 유지. 봇은 트리거·진행률만 담당, 완료 알림은 server.js가 단일 발송.

### 운영 노트

- `mp3bot/`의 `getUpdates` long-polling은 `Read timed out (60s)` / 간헐적 DNS 실패 로그가 잦음 — 정상 동작 중에도 발생. **`sendMessage`는 짧은 POST라 무관**, server.js 알림은 정상 작동 (검증 완료, message_id=8698, 8699).
- Telegram 장애 시 fallback: `files.html`에서 직접 확인.
- `.env` 또는 PM2 `ecosystem.config.js` 변경 후엔 `npx pm2 restart sermon-server --update-env` (PATH 변경 시는 `pm2 kill && pm2 start ecosystem.config.js`).

## Key Functions (server.js)

### YouTube & Audio Processing
- `getYouTubeTitle(url)` - yt-dlp로 유튜브 제목 추출 (한글 인코딩)
- `convertMP4ToMP3(input, output)` - FFmpeg MP4→MP3 변환
- `prepareAudioForWhisper(path)` - 16kHz 다운샘플링, 24MB 초과 시 자동 분할
- `uploadChunkToWhisper(path, key, lang)` - Whisper API 업로드 (3회 재시도)
- `processMP3InBackground(jobId, ...)` - 백그라운드 다운로드 + 요약 자동 생성

### Transcription & Translation
- `transcribeAudio(path)` - 영어 STT (Whisper, Markdown 포맷)
- `transcribeAudioKorean(path)` - 한국어 STT (Whisper)
- `translateToKorean(text)` - 영→한 번역 (Google Translate → Grok fallback)
- `formatEnglishMarkdown(text)` / `formatKoreanMarkdown(text)` - 마크다운 포맷팅

### AI Analysis
- `callAIChat(model, system, user, maxTokens, temp)` - Grok API 호출 (모델 폴백 체인)
- `summarizeKorean(text)` - Grok 기반 한국어 요약 (map-reduce)
- `summarizeLongTranscript({...})` - 긴 자막 청크 분할 요약
- `buildUserPromptFromTemplate(template, transcript, type)` - 프롬프트 템플릿 치환

### Sieun Feature
- `processSieunVideo(jobId, file)` - MP4→MP3→STT→번역 전체 파이프라인
- `saveSieunHistory(data)` - Supabase 이력 저장

## Environment Variables

```
SUPABASE_URL                    # Supabase 프로젝트 URL
SUPABASE_KEY                    # Supabase anon key
OPENAI_API_KEY                  # OpenAI API key (Whisper STT 전용)
AI_API_KEY                      # Grok API key (xAI)
AI_API_BASE_URL                 # Grok endpoint (default: https://api.x.ai/v1)
AI_MODEL                        # Grok model (default: grok-3)
GOOGLE_APPLICATION_CREDENTIALS  # Google Cloud 인증 파일 경로 (선택)
PORT                            # 서버 포트 (default: 9897)
NODE_ENV                        # production 시 HTTPS 리다이렉트
TELEGRAM_BOT_TOKEN              # 변환 완료 알림용 Telegram 봇 토큰 (선택, 둘 다 set이어야 동작)
TELEGRAM_CHAT_ID                # 알림 받을 채팅 ID (jinjuno1: 155671452)
PUBLIC_BASE_URL                 # 알림 메시지의 다운로드 링크 베이스 (예: http://112.223.44.142:9897)
```

## Architectural Patterns

### Background Job Processing
- In-memory Maps (`backgroundJobs`, `sieunJobs`)로 작업 상태 관리
- 즉시 HTTP 응답 후 비동기 처리, SSE로 실시간 진행률 전송
- 완료 후 5분 뒤 자동 정리

### Audio Processing Pipeline
1. YouTube URL → yt-dlp 다운로드 (시간 범위 지정)
2. FFmpeg MP3 변환 (192kbps)
3. Whisper용 다운샘플링 (16kHz mono 32kbps)
4. 24MB 초과 시 15분 단위 자동 청크 분할
5. Whisper STT → 텍스트 결합 → 요약 생성

### Grok API Model Fallback
```
[사용자 설정 모델] → grok-3 → grok-3-mini → grok-2-1212 → grok-2
```

### Prompt Templates (5종)
1. 상세 분석형 - 상세한 설교 분석
2. 교육/강의 - 교육 목적 분석
3. 기본 설교 - 일반 설교 요약
4. 설교 심화 - 심화 분석
5. 소그룹 - 소그룹 스터디용

### Error Handling
- 한국어 에러 메시지
- Whisper 3회 재시도
- DB 미연결 시 로컬 파일 저장으로 graceful degradation
- 임시 파일 자동 정리

## Development Notes

- **Single-file backend**: 모든 서버 로직이 server.js 한 파일에 집중 (2,437 lines)
- **File size limits**: 업로드 500MB, Whisper 청크 24MB
- **Korean encoding**: yt-dlp 스폰 시 `PYTHONIOENCODING=utf-8` 필수
- **yt-dlp options**: `--legacy-server-connect`, `--force-ipv4`, Android user-agent, cookies.txt 지원
- **No cron jobs**: 현재 예약 작업 없음 (CRON_JOBS.md에 구현 가이드 있음)
- **Grok Audio**: 미지원 확인됨 (GROK_AUDIO_ANALYSIS.md 참조)
- **Dependencies**: express, @supabase/supabase-js, axios, multer, openai, @google-cloud/translate, cors, dotenv, form-data

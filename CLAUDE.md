# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **Backend**: Express.js (server.js, ~3,280 lines)
- **Frontend**: Multi-page HTML + TailwindCSS + Feather Icons (~4,000 lines total)
- **Database**: Supabase (PostgreSQL)
- **Audio/Video Processing**: FFmpeg + yt-dlp pipeline (MP3 추출 + MP4 요약 편집)
- **AI/STT**: OpenAI Whisper (transcription, verbose_json 타임스탬프), Grok API (text analysis/summarization)
- **Translation**: Google Cloud Translate (primary), Grok API (fallback)
- **YouTube Upload**: googleapis (YouTube Data API v3, OAuth refresh token)
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
│   ├── api.html               # Full management UI: MP3변환, 파일목록, SUMMARY, MP4 4탭 (~2,830 lines)
│   ├── sieun.html             # Mobile-optimized 시은이: MP4→MP3→영어→한국어 (550 lines)
│   ├── sieun.file.html        # 시은이 히스토리 뷰어 with analytics (466 lines)
│   ├── files.html             # MP3 파일 목록 (local + Supabase 통합, 296 lines)
│   └── mp.html                # Android 벨소리 만들기 Intent bridge (125 lines)
├── sieun/                     # 시은이 처리 결과 저장 (mp4, mp3, en.txt, ko.txt per job)
├── uploads/                   # MP3 파일 저장, temp/ 하위 임시 파일
│   └── temp/                  # Temporary processing files
├── mp4/                       # MP4 요약 결과 (원본/요약 mp4, DB 미연결 시 index.json 폴백)
├── scripts/
│   └── get-youtube-token.js   # YouTube OAuth refresh token 발급 헬퍼 (node로 단독 실행)
├── youtubemp3/                # YouTube MP3 관련 파일
├── SQL_MP4_SUMMARY.md         # Supabase에서 실행할 DDL (mp4_summary 테이블, youtube_summary.url 컬럼)
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
| `youtube_summary` | 영상 요약 (STT 본문) | jemok, bonmun, url (원본 유튜브 URL) |
| `mp4_summary` | MP4 요약 게시판 | title, youtube_url, original_file, summary_file, youtube_video_id, status |
| `sieun_history` | 시은이 처리 이력 | original_filename, english_text, korean_text, mp3_file_path |

- `openai_result` 테이블과 `youtube_summary.youyak` 컬럼은 더 이상 사용하지 않음 (2026-07 MP4 개편).
- `mp4_summary` 테이블/`url` 컬럼이 없어도 동작: MP4 목록은 `mp4/index.json` 로컬 폴백, summary 조회는 url 없이 재시도. DDL은 SQL_MP4_SUMMARY.md 참고.

## API Endpoints (server.js)

### MP3 Extraction
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/extract-mp3` | YouTube MP3 추출 (시간 범위 지정, SSE 진행률, `makeMp4:true`면 MP4 요약까지 자동) |
| GET/POST | `/api/convert` | 외부 API용 MP3 변환 |
| GET | `/audio/:filename` | 오디오 스트리밍 (HTTP Range 지원) |

### MP4 요약 (설교 영상 7~9분 발췌 편집)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/mp4-summary` | `{url, start?, end?, title?, summaryId?}` → 백그라운드로 원본 다운로드→타임스탬프 STT→3-pass AI 구간선정→FFmpeg 컷/병합→YouTube 업로드 |
| GET | `/api/mp4` | MP4 게시판 목록 (페이징/검색, Supabase 실패 시 mp4/index.json 폴백) |
| DELETE | `/api/mp4/:id` | 레코드 + 로컬 mp4 파일 삭제 |
| GET | `/mp4/:filename` | MP4 스트리밍 (HTTP Range 지원) |

### YouTube Summary CRUD
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/summary` | 목록 조회 (페이징, 검색 — jemok/bonmun) |
| POST | `/api/summary` | 새 요약 생성 |
| GET/PUT/DELETE | `/api/summary/:id` | 개별 요약 조회/수정/삭제 |
| POST | `/api/summary/:id/html` | 본문을 AI로 정리(요약 아님)한 스탠드얼론 HTML 다운로드 (구 PDF 기능 대체) |

(구 `/api/openai-result*` 라우트는 2026-07 제거됨)

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

- `&makeMp4=1`을 붙이면 MP3 완료 후 MP4 요약(7~9분 발췌 영상)까지 자동 생성.
- 주의: 웹 UI(api.html)의 변환 폼도 `/api/extract-mp3`가 아니라 `POST /api/convert`를 호출한다. convert 라우트(GET/POST 모두)가 makeMp4를 handleMp3Extraction에 전달해야 체크박스가 동작한다 (2026-07-17 버그 수정됨).

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
- `organizeBonmunToHtml(jemok, bonmun)` - 본문 AI 정리(요약 금지) + marked 렌더 → HTML 다운로드용

### MP4 Summary Pipeline
- `processMp4SummaryInBackground(jobId, {...})` - 전체 파이프라인 (다운로드→STT→선정→편집→업로드)
- `transcribeWithTimestamps(audioPath)` - Whisper verbose_json + word 타임스탬프, 청크별 ffprobe 실측 오프셋 누적, no_speech_prob>0.6 제외
- `selectSummaryClips(segments, targetSec)` - 3-pass LLM (Planner→Selector→Reviewer rubric 루프 최대 2회), LLM은 블록 인덱스만 출력(타임스탬프 환각 차단), 실패 시 균등 샘플링 폴백
- `cutAndConcatClips(...)` - 클립별 재인코딩(-c copy 금지) + 0.2s a/v fade + concat demuxer
- `uploadToYouTube(filePath, {title, description})` - 환경변수 3종 미설정 시 skip, 실패해도 파이프라인 계속
- `mp4CreateRecord/mp4UpdateRecord` - Supabase 우선, 실패 시 mp4/index.json 폴백

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
YOUTUBE_CLIENT_ID               # YouTube 자동 업로드 (선택, 3종 모두 set이어야 동작)
YOUTUBE_CLIENT_SECRET           # Google Cloud OAuth 클라이언트 (데스크톱 앱)
YOUTUBE_REFRESH_TOKEN           # scripts/get-youtube-token.js로 발급
YOUTUBE_PRIVACY_STATUS          # 업로드 공개 범위 (기본 unlisted)
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

### MP4 요약 4-pass 에이전트 패턴 (selectSummaryClips, 2026-07-17 개선판)
1. **Pass 0 설교구간 식별(detectSermonRange)**: 예배 실황에서 광고/찬양/새가족/기도 등 비설교 블록을 범위 밖으로 배제 (코드에서 후보 목록 자체를 슬라이스 — 프롬프트 지시만으로는 광고를 설교 서론으로 착각함). AI가 준 블록 번호는 거부하지 말고 클램프. 이후 `isLiturgyBlock` 휴리스틱(찬양대/헌금/봉독 키워드 + 반복 가사의 고유단어비율<0.4)으로 구간 머리/꼬리를 추가 정리 — 예배 순서가 "봉독→헌금→찬양대→설교"인 경우 AI가 봉독을 설교 시작으로 오판하는 것 방어
2. **Pass 1 기획(Planner)**: 전체 블록 목록을 직접 보고 발췌 기획안 작성 — outline + **스토리(예화·간증) 목록**(잘라내기 금지 덩어리)
3. **Pass 2 선정(Selector)**: 기획안 기반 블록 인덱스 구간 선정 (스토리 통째 규칙, 끊김 금지)
4. **Pass 3 검증(Reviewer)**: rubric 7항목 평가, 수정 루프 최대 2회
- **모델**: 이 4개 패스는 `CLIP_AI_MODELS`(grok-4-0709, 추론형) 우선 사용 — fast-non-reasoning 모델은 다중 제약을 못 지켜 클립 1개만 선정하는 문제 있음
- **코드 차원 보정 (LLM 불신 원칙)**: `enforceStructure` — 과대 클립(>300초) 사전 축소(서론/결론 검사보다 먼저 — 순서 중요), 서론/결론 클립 없으면 자동 추가, 미포함 스토리 자동 추가. `postProcessBlockClips` — 스토리 부분겹침 시 전체 확장, 길이 조정 시 스토리 클립 보호, 문장 완결 블록 경계(`buildBlocks`가 종결어미 기준 분할), word 타임스탬프 −0.25s/+0.45s 패딩, 하드캡 600초(완결 우선 630 허용)
- **퇴화 방어 가드 (2026-07-17 추가)**: ① 스토리 과대 식별 필터(개별≤240초, 보호 총량≤360초 — 기획 AI가 설교 80%를 스토리로 지정해 하드캡 절단 유발한 사례), ② `countMergedClips`로 "위장 통짜"(여러 클립이지만 병합하면 1~2덩어리) 감지 시 재선정 1회, ③ Reviewer가 클립을 3개 미만으로 줄이는 수정안 거부. **주의: 추론형 모델(grok-4-0709)은 '끊김 금지' 규칙을 과잉 해석해 설교 전체를 통짜 클립으로 선정하는 경향** → 몽타주 원칙(서로 떨어진 4~7개, 클립당 30~120초)을 프롬프트에 명시해야 함
- **자체 검증 루프 내장 (2026-07-17)**: 편집 완료 후 결과물을 자동 전사(`transcribeSummaryPlain`) → rubric 평가(`verifySummaryQuality`: 시작=설교 서론 / 끝=축원 완결 / 비설교 혼입 / 흐름) → 불합격 시 사유를 Selector 피드백으로 전달해 재선정·재편집 (최대 2회 시도). Telegram 알림에 "📋 자체 검증: 통과/보완 후 통과/미흡" 표시. 검증 시스템 오류 시엔 통과 처리(파이프라인 무중단).
- **초장문 세그먼트 분할**: Whisper가 찬양/음악 구간에서 수 분짜리 세그먼트를 반환하면 블록이 거칠어져 모든 가드가 무뎌짐 → `buildBlocks`가 55초 초과 세그먼트를 word 타임스탬프로 ~35초 단위 분할
- 수동 검증 방법: 요약 mp4를 ffmpeg로 오디오 추출 → Whisper 전사 → 시작(서론)/스토리 완결/끝(결론) 직접 확인

### Error Handling
- 한국어 에러 메시지
- Whisper 3회 재시도
- DB 미연결 시 로컬 파일 저장으로 graceful degradation
- 임시 파일 자동 정리

## Development Notes

- **Single-file backend**: 모든 서버 로직이 server.js 한 파일에 집중 (~3,280 lines)
- **File size limits**: 업로드 500MB, Whisper 청크 24MB
- **Korean encoding**: yt-dlp 스폰 시 `PYTHONIOENCODING=utf-8` 필수
- **yt-dlp options**: `--legacy-server-connect`, `--force-ipv4`, Android user-agent, cookies.txt 지원
- **No cron jobs**: 현재 예약 작업 없음 (CRON_JOBS.md에 구현 가이드 있음)
- **Grok Audio**: 미지원 확인됨 (GROK_AUDIO_ANALYSIS.md 참조)
- **Dependencies**: express, @supabase/supabase-js, axios, multer, openai, @google-cloud/translate, cors, dotenv, form-data, googleapis, marked (pdfkit은 2026-07 제거)

# 🎵 설교 관리 시스템

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-v14+-green.svg)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-4.18+-blue.svg)](https://expressjs.com/)

YouTube 영상에서 설교 구간을 MP3로 추출하고 체계적으로 관리할 수 있는 교회 전용 웹 애플리케이션입니다.

## ✨ 주요 기능

- 🎬 **YouTube MP3 추출**: 지정한 시간 구간만 정확히 추출
- 📊 **실시간 진행상황**: Server-Sent Events로 변환 진행률 표시  
- 🗂️ **설교 관리**: 제목, 날짜, 음성인식 텍스트 체계적 관리
- 🎵 **오디오 스트리밍**: 브라우저에서 바로 재생 가능
- 📱 **반응형 디자인**: 모바일, 태블릿, 데스크톱 모두 지원
- ☁️ **클라우드 연동**: Supabase PostgreSQL 데이터베이스

## 🚀 빠른 시작

### 1. 사전 준비
```bash
# FFmpeg 설치 (Windows)
winget install FFmpeg

# yt-dlp 설치  
pip install yt-dlp
```

### 2. 프로젝트 설치
```bash
# 프로젝트 클론
git clone https://github.com/your-username/sermon-manager.git
cd sermon-manager

# 의존성 설치
npm install

# 환경설정
cp env.example .env
# .env 파일에서 Supabase 정보 입력

# 서버 실행
npm start
```

### 3. 접속
브라우저에서 `http://localhost:9899` 접속

## 📱 사용 방법

### YouTube MP3 추출
1. YouTube 설교 영상 URL 입력
2. 시작/종료 시간 설정 (예: `10:30` ~ `45:20`)
3. 설교 제목 입력 (선택사항)
4. "MP3 추출 시작" 클릭
5. 실시간 진행상황 확인 후 다운로드

### 설교 게시판 관리
1. "설교 게시판" 탭 클릭
2. "설교 추가" 버튼으로 새 설교 등록
3. 제목, 날짜, MP3/텍스트 파일 정보 입력
4. 목록에서 재생, 다운로드, 수정, 삭제 가능

## 기술 스택

- **Backend**: Node.js, Express.js
- **Frontend**: HTML, JavaScript, TailwindCSS
- **Database**: Supabase (PostgreSQL)
- **Audio Processing**: FFmpeg, yt-dlp
- **Icons**: Feather Icons

## 설치 및 실행

### 필수 요구사항
- Node.js (v14 이상)
- FFmpeg
- yt-dlp

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경 설정
프로젝트 루트에 `.env` 파일을 생성하고 다음 내용을 추가하세요:
```bash
# Supabase 설정
SUPABASE_URL=your-supabase-project-url
SUPABASE_KEY=your-supabase-anon-key

# 포트 설정 (선택사항)
PORT=9899
```

### 3. 서버 실행
```bash
# 개발 모드 (자동 재시작)
npm run dev

# 프로덕션 모드
npm start
```

### 4. 웹 브라우저에서 접속
```
http://localhost:9899
```

## 데이터베이스 설정

### Supabase 테이블 생성
`serm` 테이블을 생성하기 위한 SQL:

```sql
CREATE TABLE serm (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    date DATE NOT NULL,
    mp3_file TEXT NOT NULL,
    txt_file TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 인덱스 생성 (성능 향상)
CREATE INDEX idx_serm_date ON serm(date);
CREATE INDEX idx_serm_title ON serm(title);
```

## 외부 호스팅 설정 (선택사항)

파일을 외부에서 접근 가능하도록 하려면 다음 방법들을 사용할 수 있습니다:

### 1. FTP 서버 설정
```bash
# .env 파일에 FTP 정보 추가 (선택사항)
FTP_HOST=your-ftp-host
FTP_USER=your-ftp-username
FTP_PASS=your-ftp-password
FTP_PATH=/your-path/
```

### 2. 클라우드 스토리지
- AWS S3
- Google Cloud Storage  
- Azure Blob Storage

### 3. 외부 URL 예시
- **MP3 파일**: `https://your-domain.com/sermon/설교.mp3`
- **텍스트 파일**: `https://your-domain.com/sermon/설교.txt`

## API 엔드포인트

### MP3 추출
- `POST /api/extract-mp3` - YouTube에서 MP3 추출

### 설교 관리
- `GET /api/sermons` - 설교 목록 조회 (페이지네이션 지원)
- `POST /api/sermons` - 설교 생성
- `GET /api/sermons/:id` - 설교 상세 조회
- `PUT /api/sermons/:id` - 설교 수정
- `DELETE /api/sermons/:id` - 설교 삭제

## 사용법

### 1. YouTube MP3 추출
1. 첫 번째 탭에서 YouTube 링크 입력
2. 시작/종료 시간 설정 (HH:MM:SS 형식)
3. 설교 제목 입력 (선택사항)
4. "MP3 추출 시작" 버튼 클릭
5. 추출 완료 후 결과 확인

### 2. 설교 관리
1. 두 번째 탭에서 "설교 추가" 버튼 클릭
2. 설교 정보 입력 (제목, 날짜, MP3 파일, 텍스트 파일)
3. 저장 후 설교 목록에서 관리
4. 수정/삭제/재생/텍스트 복사 기능 사용

## 주의사항

- FFmpeg와 yt-dlp가 시스템에 설치되어 있어야 합니다
- YouTube 링크는 공개 영상이어야 합니다
- 시간 형식은 반드시 HH:MM:SS 형식을 따라야 합니다
- 대용량 파일 처리 시 시간이 오래 걸릴 수 있습니다

## 문제 해결

### FFmpeg 오류
- FFmpeg가 PATH에 추가되어 있는지 확인
- Windows에서는 `ffmpeg.exe`가 실행 가능한지 확인

### yt-dlp 오류
- yt-dlp가 최신 버전인지 확인: `pip install -U yt-dlp`
- YouTube 정책 변경으로 인한 오류일 수 있음

### 권한 오류
- uploads 폴더에 쓰기 권한이 있는지 확인
- 임시 파일 삭제 권한 확인

## 📄 라이센스

MIT License - 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.

## 🤝 기여하기

1. 이 저장소를 Fork 하세요
2. 새 기능 브랜치를 만드세요 (`git checkout -b feature/AmazingFeature`)
3. 변경사항을 커밋하세요 (`git commit -m 'Add some AmazingFeature'`)
4. 브랜치에 Push 하세요 (`git push origin feature/AmazingFeature`)
5. Pull Request를 열어주세요

## 📞 지원 및 문의

- **Issues**: [GitHub Issues](https://github.com/your-username/sermon-manager/issues)
- **Wiki**: [프로젝트 Wiki](https://github.com/your-username/sermon-manager/wiki)
- **배포 가이드**: [DEPLOYMENT.md](DEPLOYMENT.md)

## ⭐ 스타 히스토리

[![Star History Chart](https://api.star-history.com/svg?repos=your-username/sermon-manager&type=Date)](https://star-history.com/#your-username/sermon-manager&Date)

---

**🙏 이 프로젝트가 교회 사역에 도움이 되기를 기도합니다!** 
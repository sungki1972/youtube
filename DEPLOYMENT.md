# 🚀 배포 가이드

## 📋 사전 준비사항

### 1. 필수 소프트웨어 설치
- **Node.js** (v14 이상)
- **FFmpeg** 
- **yt-dlp** (`pip install yt-dlp`)

### 2. Supabase 프로젝트 생성
1. [Supabase](https://supabase.com)에서 새 프로젝트 생성
2. 데이터베이스 테이블 생성 (README.md 참고)
3. API URL과 anon key 확인

## 🔧 로컬 설정

### 1. 프로젝트 클론
```bash
git clone https://github.com/your-username/sermon-manager.git
cd sermon-manager
```

### 2. 의존성 설치
```bash
npm install
```

### 3. 환경변수 설정
```bash
# env.example을 .env로 복사
cp env.example .env

# .env 파일 수정
nano .env
```

### 4. 서버 실행
```bash
# 개발 모드
npm run dev

# 프로덕션 모드  
npm start
```

## ☁️ 클라우드 배포

### Vercel 배포
```bash
# Vercel CLI 설치
npm i -g vercel

# 배포
vercel --prod
```

### Heroku 배포
```bash
# Heroku CLI 설치 후
heroku create your-app-name
git push heroku main
```

### Railway 배포
1. [Railway](https://railway.app) 계정 생성
2. GitHub 연동
3. 환경변수 설정
4. 자동 배포

### Docker 배포
```dockerfile
# Dockerfile 예시
FROM node:16-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
EXPOSE 9899

CMD ["npm", "start"]
```

## 🔐 보안 설정

### 1. 환경변수 설정
- `SUPABASE_URL`: Supabase 프로젝트 URL
- `SUPABASE_KEY`: Supabase anon key
- `NODE_ENV=production`

### 2. HTTPS 설정
- SSL 인증서 적용
- 자동 HTTPS 리다이렉트 활성화

### 3. 방화벽 설정
- 필요한 포트만 열기 (9899, 80, 443)
- SSH 접근 제한

## 📊 모니터링

### 1. 로그 확인
```bash
# PM2 사용 시
pm2 logs sermon-manager

# Docker 사용 시
docker logs container-name
```

### 2. 성능 모니터링
- CPU, 메모리 사용량 확인
- 디스크 공간 모니터링
- 네트워크 트래픽 확인

## 🔄 업데이트

### 1. 코드 업데이트
```bash
git pull origin main
npm install
npm restart
```

### 2. 데이터베이스 마이그레이션
```sql
-- 필요 시 테이블 구조 변경
ALTER TABLE serm ADD COLUMN new_field TEXT;
```

## 🆘 문제 해결

### 1. 일반적인 오류
- **FFmpeg 없음**: `which ffmpeg`로 설치 확인
- **yt-dlp 오류**: `pip install -U yt-dlp`로 업데이트
- **포트 충돌**: `.env`에서 PORT 변경

### 2. 성능 최적화
- uploads 폴더 정기 정리
- 큰 파일 압축
- CDN 사용 고려

## 📞 지원

문제 발생 시:
1. GitHub Issues 확인
2. 로그 파일 확인
3. 환경변수 재확인
4. 의존성 버전 확인

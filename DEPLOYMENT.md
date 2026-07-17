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
EXPOSE 9897

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
- 필요한 포트만 열기 (9897, 80, 443)
- SSH 접근 제한

## 📊 모니터링

### 1. PM2 ecosystem 설정으로 실행
```bash
# ecosystem.config.js 사용 (자동 재시작, 로그 관리, 메모리 제한 포함)
pm2 start ecosystem.config.js

# 또는 Windows에서
start-pm2.bat
```

### 2. 로그 확인
```bash
# PM2 실시간 로그
pm2 logs sermon-server

# 로그 파일 직접 확인
# logs/out.log      - 표준 출력
# logs/error.log    - 에러 로그
# logs/combined.log - 통합 로그
```

### 3. 성능 모니터링
- `pm2 monit` - CPU, 메모리 실시간 모니터링
- `pm2 list` - 프로세스 상태 확인
- 디스크 공간 모니터링
- 네트워크 트래픽 확인

### 4. UptimeRobot 외부 모니터링 (무료)

서버 다운 시 이메일 알림을 받으려면 [UptimeRobot](https://uptimerobot.com)을 설정하세요.

1. https://uptimerobot.com 에서 무료 가입
2. Dashboard → **+ Add New Monitor** 클릭
3. 설정:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: Sermon Server
   - **URL**: `http://112.223.44.142:9897/api/health`
   - **Monitoring Interval**: 5 minutes
4. **Alert Contacts** 에서 이메일 알림 설정
5. **Create Monitor** 클릭

설정 후 5분마다 `/api/health` 엔드포인트를 체크하며, 서버가 응답하지 않으면 이메일로 알림을 보냅니다.

#### 헬스체크 응답 예시
```json
{
  "status": "ok",
  "uptime": 3600.123,
  "timestamp": "2026-02-15T12:00:00.000Z"
}
```

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

## 🏠 로컬 서버 외부 접속 (포트포워딩)

클라우드 배포 없이 로컬 PC에서 외부 접속을 허용하는 방법입니다.

### 1. 내부 IP 확인
```cmd
ipconfig
```
- **IPv4 주소** 확인 (예: `192.168.0.10`)
- 보통 `192.168.0.x` 또는 `192.168.1.x` 형태

### 2. 라우터 포트포워딩 설정
1. 브라우저에서 라우터 관리 페이지 접속
   - 일반적: `http://192.168.0.1` 또는 `http://192.168.1.1`
   - KT: `http://172.30.1.254`
   - SK: `http://192.168.25.1`
   - LG: `http://192.168.219.1`
2. 로그인 (기본 ID/PW는 라우터 뒷면 확인)
3. **포트포워딩** (또는 "가상서버", "NAT 설정") 메뉴 찾기
4. 규칙 추가:
   - **외부 포트**: `9897`
   - **내부 IP**: 위에서 확인한 IPv4 주소 (예: `192.168.0.10`)
   - **내부 포트**: `9897`
   - **프로토콜**: TCP
5. 저장 후 적용

### 3. Windows 방화벽 인바운드 규칙 추가
```cmd
# 관리자 권한 CMD에서 실행
netsh advfirewall firewall add rule name="Sermon Server 9897" dir=in action=allow protocol=tcp localport=9897
```

또는 GUI로 설정:
1. Windows 검색 → "Windows Defender 방화벽" → "고급 설정"
2. "인바운드 규칙" → "새 규칙"
3. 포트 → TCP → 특정 포트: `9897` → 연결 허용 → 이름 지정

### 4. 외부 IP 확인
```cmd
# 브라우저에서 확인
# https://whatismyip.com 접속

# 또는 CMD에서
curl ifconfig.me
```

외부에서 접속: `http://[외부IP]:9897`

### 5. 동적 IP 대응 (DDNS)
가정용 인터넷은 IP가 주기적으로 변경됩니다. 무료 DDNS 서비스를 사용하세요:

- **No-IP** (https://www.noip.com) - 무료, 30일마다 갱신
- **Duck DNS** (https://www.duckdns.org) - 완전 무료
- **Dynu** (https://www.dynu.com) - 무료

설정 후 `http://your-name.ddns.net:9897`로 접속 가능합니다.

### 6. 주의사항
- 공유기/라우터 재부팅 시 포트포워딩 설정이 초기화될 수 있음
- PC의 내부 IP가 변경될 수 있으므로 DHCP 고정 할당 권장
- 보안을 위해 불필요한 포트는 열지 말 것
- PM2로 서버 자동 재시작 설정 권장 (`npm run start:pm2`)

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






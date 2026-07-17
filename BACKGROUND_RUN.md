# Windows에서 npm start 백그라운드 실행 방법

Windows 환경에서 `npm start`를 백그라운드로 실행하는 여러 방법을 정리했습니다.

## 🎯 방법 1: PM2 사용 (가장 추천 ⭐)

PM2는 Node.js 프로세스 관리자로, 프로덕션 환경에서 가장 안정적입니다.

### 설치
```powershell
npm install -g pm2
```

### 실행
```powershell
# 방법 1: server.js를 직접 실행 (추천)
pm2 start server.js --name "sermon-server"

# 방법 2: npm start 사용 (Windows에서는 문제가 있을 수 있음)
pm2 start npm --name "sermon-server" -- start
```

**⚠️ 주의**: Windows에서 `pm2 start npm -- start`는 에러가 발생할 수 있습니다. `server.js`를 직접 실행하는 방법을 권장합니다.

### 주요 명령어
```powershell
# 실행 중인 프로세스 확인
pm2 list

# 로그 확인
pm2 logs sermon-server

# 실시간 모니터링
pm2 monit

# 프로세스 중지
pm2 stop sermon-server

# 프로세스 재시작
pm2 restart sermon-server

# 프로세스 삭제
pm2 delete sermon-server

# 시스템 재부팅 시 자동 시작 설정
pm2 startup
pm2 save
```

### 장점
- ✅ 프로세스가 죽으면 자동 재시작
- ✅ 로그 파일 자동 관리
- ✅ 메모리 사용량 모니터링
- ✅ 시스템 재부팅 후 자동 시작 가능
- ✅ 여러 인스턴스 클러스터 모드 지원

---

## 🎯 방법 2: PowerShell Start-Process 사용

PowerShell의 `Start-Process`를 사용하여 백그라운드로 실행합니다.

### 실행
```powershell
# 새 창 없이 백그라운드 실행
Start-Process node -ArgumentList "server.js" -WindowStyle Hidden

# 또는 npm start 사용
Start-Process npm -ArgumentList "start" -WindowStyle Hidden
```

### 프로세스 확인 및 종료
```powershell
# 실행 중인 Node 프로세스 확인
Get-Process node

# 특정 포트를 사용하는 프로세스 찾기
netstat -ano | findstr :9897

# 프로세스 종료 (PID 확인 후)
Stop-Process -Id <PID번호> -Force
```

### 장점
- ✅ 추가 설치 불필요 (Windows 기본 기능)
- ✅ 간단한 실행

### 단점
- ❌ 프로세스 추적이 어려움
- ❌ 자동 재시작 없음
- ❌ 로그 관리 수동

---

## 🎯 방법 3: CMD start 명령어 사용

CMD에서 `start` 명령어로 새 창에서 실행합니다.

### 실행
```cmd
REM 새 창에서 실행 (창은 보임)
start "Sermon Server" cmd /k "npm start"

REM 백그라운드 실행 (창 숨김)
start /B "Sermon Server" cmd /c "npm start > server.log 2>&1"
```

### 장점
- ✅ 추가 설치 불필요
- ✅ 간단한 실행

### 단점
- ❌ 프로세스 관리가 어려움
- ❌ 자동 재시작 없음

---

## 🎯 방법 4: Windows 작업 스케줄러 사용

시스템 재부팅 후 자동으로 시작되도록 설정합니다.

### 설정 방법
1. 작업 스케줄러 열기 (Win + R → `taskschd.msc`)
2. "기본 작업 만들기" 클릭
3. 이름: "Sermon Server"
4. 트리거: "컴퓨터 시작 시"
5. 작업: "프로그램 시작"
6. 프로그램: `node` (또는 `npm`)
7. 인수: `server.js` (또는 `start`)
8. 시작 위치: 프로젝트 폴더 경로 (예: `C:\Users\neola\OneDrive\문서\cursor\25\8\mp3`)

### 장점
- ✅ 시스템 재부팅 후 자동 시작
- ✅ Windows 서비스처럼 동작

### 단점
- ❌ 설정이 복잡함
- ❌ 로그 확인이 어려움

---

## 🎯 방법 5: forever 사용

PM2의 대안으로 사용할 수 있는 프로세스 관리자입니다.

### 설치
```powershell
npm install -g forever
```

### 실행
```powershell
forever start server.js
```

### 주요 명령어
```powershell
# 실행 중인 프로세스 확인
forever list

# 로그 확인
forever logs

# 프로세스 중지
forever stop server.js

# 프로세스 재시작
forever restart server.js
```

---

## 📝 추천 방법 비교

| 방법 | 설치 필요 | 자동 재시작 | 로그 관리 | 추천도 |
|------|----------|------------|----------|--------|
| **PM2** | ✅ | ✅ | ✅ | ⭐⭐⭐⭐⭐ |
| PowerShell | ❌ | ❌ | ❌ | ⭐⭐⭐ |
| CMD start | ❌ | ❌ | ❌ | ⭐⭐ |
| 작업 스케줄러 | ❌ | ✅ | ❌ | ⭐⭐⭐ |
| forever | ✅ | ✅ | ✅ | ⭐⭐⭐⭐ |

---

## 🚀 빠른 시작 (PM2 사용)

가장 간단하게 시작하려면:

```powershell
# 1. PM2 설치
npm install -g pm2

# 2. 서버 시작 (server.js 직접 실행)
pm2 start server.js --name "sermon-server"

# 3. 상태 확인
pm2 list

# 4. 로그 확인
pm2 logs sermon-server
```

---

## 📋 제공된 스크립트 파일

프로젝트에 다음 스크립트 파일들이 포함되어 있습니다:

- `start-background.ps1` - PowerShell로 백그라운드 실행
- `start-background.bat` - CMD로 백그라운드 실행
- `start-pm2.bat` - PM2로 실행 (PM2 설치 필요)

각 스크립트를 더블클릭하거나 명령줄에서 실행하면 됩니다.

---

## ⚠️ 주의사항

1. **포트 충돌**: 이미 서버가 실행 중이면 포트 9897가 사용 중일 수 있습니다.
   ```powershell
   # 포트 사용 확인
   netstat -ano | findstr :9897
   ```

2. **로그 확인**: 백그라운드 실행 시 로그를 확인할 수 있는 방법을 마련해야 합니다.
   - PM2: `pm2 logs`
   - PowerShell: 로그 파일로 리다이렉트

3. **프로세스 종료**: 백그라운드 실행 시 프로세스를 종료하는 방법을 알아야 합니다.
   - PM2: `pm2 stop sermon-server`
   - PowerShell: `Get-Process node | Stop-Process`

---

## 🔧 문제 해결

### 서버가 시작되지 않을 때
1. 포트가 이미 사용 중인지 확인
2. Node.js가 설치되어 있는지 확인: `node --version`
3. 의존성이 설치되어 있는지 확인: `npm install`

### 프로세스를 찾을 수 없을 때
```powershell
# 모든 Node 프로세스 확인
Get-Process node

# 특정 포트 사용 프로세스 확인
netstat -ano | findstr :9897
```

### 로그를 확인하고 싶을 때
- PM2 사용 시: `pm2 logs sermon-server`
- 직접 실행 시: 로그 파일 확인 또는 콘솔 출력 확인


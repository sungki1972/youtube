@echo off
REM PM2를 사용하여 서버를 백그라운드로 실행
REM 사용법: PM2가 설치되어 있어야 합니다 (npm install -g pm2)

echo ========================================
echo 설교 관리 서버 PM2 실행
echo ========================================
echo.

REM 현재 디렉토리로 이동
cd /d "%~dp0"

REM PM2 설치 확인
where pm2 >nul 2>&1
if %errorlevel% neq 0 (
    echo ⚠️  PM2가 설치되어 있지 않습니다!
    echo.
    echo PM2를 설치하려면 다음 명령을 실행하세요:
    echo npm install -g pm2
    echo.
    pause
    exit /b 1
)

REM 포트 사용 확인
echo 포트 9897 사용 확인 중...
netstat -ano | findstr :9897 >nul
if %errorlevel% equ 0 (
    echo ⚠️  포트 9897가 이미 사용 중입니다!
    echo 기존 PM2 프로세스를 확인합니다...
    pm2 list
    echo.
    echo 기존 프로세스를 중지하시겠습니까? (Y/N)
    set /p response=
    if /i "%response%"=="Y" (
        pm2 stop sermon-server 2>nul
        pm2 delete sermon-server 2>nul
        timeout /t 2 >nul
    )
)

echo.
echo 서버를 PM2로 시작합니다...
echo.

REM PM2로 서버 시작 (ecosystem.config.js 사용)
pm2 start ecosystem.config.js

if %errorlevel% equ 0 (
    echo.
    echo ✅ 서버가 PM2로 시작되었습니다!
    echo.
    echo 주요 명령어:
    echo   - 상태 확인: pm2 list
    echo   - 로그 확인: pm2 logs sermon-server
    echo   - 모니터링: pm2 monit
    echo   - 중지: pm2 stop sermon-server
    echo   - 재시작: pm2 restart sermon-server
    echo   - 삭제: pm2 delete sermon-server
    echo.
    echo 브라우저에서 http://localhost:9897 로 접속하세요.
    echo.
    
    REM PM2 상태 표시
    pm2 list
) else (
    echo ❌ 서버 시작 실패!
    echo.
    pause
    exit /b 1
)

pause


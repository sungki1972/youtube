@echo off
REM 서버 중지 스크립트
REM 여러 방법으로 실행 중인 서버를 찾아서 중지합니다

echo ========================================
echo 설교 관리 서버 중지
echo ========================================
echo.

REM 현재 디렉토리로 이동
cd /d "%~dp0"

REM PM2로 실행 중인 경우
where pm2 >nul 2>&1
if %errorlevel% equ 0 (
    pm2 list | findstr sermon-server >nul
    if %errorlevel% equ 0 (
        echo PM2로 실행 중인 서버를 중지합니다...
        pm2 stop sermon-server
        pm2 delete sermon-server
        echo ✅ PM2 서버가 중지되었습니다.
        goto :end
    )
)

REM PID 파일이 있는 경우
if exist server.pid (
    echo PID 파일에서 프로세스 ID를 확인합니다...
    set /p PID=<server.pid
    tasklist | findstr "%PID%" >nul
    if %errorlevel% equ 0 (
        echo 프로세스 %PID%를 중지합니다...
        taskkill /F /PID %PID% >nul 2>&1
        del server.pid
        echo ✅ 서버가 중지되었습니다.
        goto :end
    )
)

REM 포트 9897를 사용하는 프로세스 찾기
echo 포트 9897를 사용하는 프로세스를 찾습니다...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :9897 ^| findstr LISTENING') do (
    set PID=%%a
    echo 프로세스 %%a를 중지합니다...
    taskkill /F /PID %%a >nul 2>&1
    echo ✅ 서버가 중지되었습니다.
    goto :end
)

REM Node.js 프로세스 전체 중지 (주의!)
echo 포트 9897를 사용하는 프로세스를 찾을 수 없습니다.
echo 모든 Node.js 프로세스를 중지하시겠습니까? (Y/N)
set /p response=
if /i "%response%"=="Y" (
    taskkill /F /IM node.exe >nul 2>&1
    echo ✅ 모든 Node.js 프로세스가 중지되었습니다.
) else (
    echo 서버가 실행 중이지 않거나 이미 중지되었습니다.
)

:end
echo.
pause


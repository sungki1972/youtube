@echo off
REM 배치 파일: npm start를 백그라운드로 실행
REM 사용법: 더블클릭하거나 CMD에서 실행

echo ========================================
echo 설교 관리 서버 백그라운드 실행
echo ========================================
echo.

REM 현재 디렉토리로 이동
cd /d "%~dp0"

REM 포트 사용 확인
echo 포트 9897 사용 확인 중...
netstat -ano | findstr :9897 >nul
if %errorlevel% equ 0 (
    echo ⚠️  포트 9897가 이미 사용 중입니다!
    echo 기존 프로세스를 종료하시겠습니까? (Y/N)
    set /p response=
    if /i "%response%"=="Y" (
        echo 기존 Node 프로세스를 종료합니다...
        taskkill /F /IM node.exe >nul 2>&1
        timeout /t 2 >nul
    ) else (
        echo 실행을 취소했습니다.
        pause
        exit /b
    )
)

echo.
echo 서버를 백그라운드로 시작합니다...
echo 로그 파일: server.log
echo.

REM npm start를 백그라운드로 실행 (로그 파일로 리다이렉트)
start /B "Sermon Server" cmd /c "npm start > server.log 2>&1"

REM 프로세스 ID 확인 (약간의 지연 후)
timeout /t 2 >nul
for /f "tokens=2" %%a in ('netstat -ano ^| findstr :9897 ^| findstr LISTENING') do (
    set PID=%%a
    echo ✅ 서버가 백그라운드에서 시작되었습니다!
    echo 프로세스 ID: %%a
    echo %%a > server.pid
    goto :found
)

:found
echo.
echo 서버 상태 확인:
echo   - 로그 확인: type server.log
echo   - 프로세스 확인: tasklist ^| findstr node.exe
echo   - 서버 중지: taskkill /F /IM node.exe
echo.
echo 브라우저에서 http://localhost:9897 로 접속하세요.
echo.
pause


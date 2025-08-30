@echo off
echo 설교 관리 시스템 설치 스크립트
echo ================================

echo.
echo 1. Node.js 의존성 설치 중...
npm install

echo.
echo 2. FFmpeg 설치 확인...
where ffmpeg >nul 2>nul
if %errorlevel% neq 0 (
    echo FFmpeg가 설치되어 있지 않습니다.
    echo https://ffmpeg.org/download.html 에서 다운로드하여 설치하세요.
    echo 설치 후 PATH에 추가해야 합니다.
) else (
    echo FFmpeg가 설치되어 있습니다.
)

echo.
echo 3. yt-dlp 설치 확인...
where yt-dlp >nul 2>nul
if %errorlevel% neq 0 (
    echo yt-dlp가 설치되어 있지 않습니다.
    echo pip install yt-dlp 명령으로 설치하세요.
) else (
    echo yt-dlp가 설치되어 있습니다.
)

echo.
echo 4. uploads 폴더 생성...
if not exist "uploads" mkdir uploads

echo.
echo 5. 환경 설정 파일 생성...
echo # Supabase 설정 > .env
echo SUPABASE_URL=your-supabase-project-url >> .env
echo SUPABASE_KEY=your-supabase-anon-key >> .env
echo. >> .env
echo # 포트 설정 (선택사항) >> .env
echo PORT=9899 >> .env

echo.
echo ⚠️  중요: .env 파일에 실제 Supabase 정보를 입력하세요!

echo.
echo 설치가 완료되었습니다!
echo.
echo 서버를 시작하려면 다음 명령을 실행하세요:
echo npm start
echo.
echo 또는 개발 모드로 실행하려면:
echo npm run dev
echo.
echo 웹 브라우저에서 http://localhost:9899 로 접속하세요.
echo.
pause 
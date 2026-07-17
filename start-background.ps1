# PowerShell 스크립트: npm start를 백그라운드로 실행
# 사용법: PowerShell에서 .\start-background.ps1 실행

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "설교 관리 서버 백그라운드 실행" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 현재 디렉토리 확인
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptPath

# 포트 사용 확인
Write-Host "포트 9897 사용 확인 중..." -ForegroundColor Yellow
$portInUse = netstat -ano | findstr :9897
if ($portInUse) {
    Write-Host "⚠️  포트 9897가 이미 사용 중입니다!" -ForegroundColor Red
    Write-Host "기존 프로세스를 종료하시겠습니까? (Y/N)" -ForegroundColor Yellow
    $response = Read-Host
    if ($response -eq "Y" -or $response -eq "y") {
        $processes = Get-Process node -ErrorAction SilentlyContinue
        if ($processes) {
            $processes | Stop-Process -Force
            Write-Host "기존 Node 프로세스를 종료했습니다." -ForegroundColor Green
            Start-Sleep -Seconds 2
        }
    } else {
        Write-Host "실행을 취소했습니다." -ForegroundColor Yellow
        exit
    }
}

# 로그 파일 경로
$logFile = Join-Path $scriptPath "server.log"
$errorLogFile = Join-Path $scriptPath "server-error.log"

Write-Host ""
Write-Host "서버를 백그라운드로 시작합니다..." -ForegroundColor Green
Write-Host "로그 파일: $logFile" -ForegroundColor Gray
Write-Host ""

# npm start를 백그라운드로 실행
try {
    # Start-Process로 백그라운드 실행
    $process = Start-Process -FilePath "npm" `
        -ArgumentList "start" `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError $errorLogFile `
        -PassThru `
        -NoNewWindow

    Write-Host "✅ 서버가 백그라운드에서 시작되었습니다!" -ForegroundColor Green
    Write-Host "프로세스 ID: $($process.Id)" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "서버 상태 확인:" -ForegroundColor Yellow
    Write-Host "  - 로그 확인: Get-Content $logFile -Wait" -ForegroundColor Gray
    Write-Host "  - 프로세스 확인: Get-Process -Id $($process.Id)" -ForegroundColor Gray
    Write-Host "  - 서버 중지: Stop-Process -Id $($process.Id) -Force" -ForegroundColor Gray
    Write-Host ""
    Write-Host "브라우저에서 http://localhost:9897 로 접속하세요." -ForegroundColor Cyan
    Write-Host ""
    
    # 프로세스 ID를 파일에 저장 (나중에 종료할 때 사용)
    $pidFile = Join-Path $scriptPath "server.pid"
    $process.Id | Out-File -FilePath $pidFile -Encoding ASCII
    
} catch {
    Write-Host "❌ 서버 시작 실패: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}


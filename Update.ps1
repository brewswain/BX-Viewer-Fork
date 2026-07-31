# BounceX Viewer - Updater
# Double-click, or: powershell -ExecutionPolicy Bypass -File Update.ps1

Set-Location $PSScriptRoot

Write-Host ""
Write-Host "  BounceX Viewer - Updater" -ForegroundColor Cyan
Write-Host ""

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun -and (Test-Path "$env:USERPROFILE\.bun\bin\bun.exe")) {
    # Installed but not on PATH for this session yet.
    $bun = "$env:USERPROFILE\.bun\bin\bun.exe"
}

if (-not $bun) {
    Write-Host "  !! Bun not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "     Bun is the JavaScript runtime this app runs on." -ForegroundColor DarkGray
    Write-Host "     It can be installed with:  winget install Oven-sh.Bun" -ForegroundColor DarkGray
    Write-Host ""
    $ans = Read-Host "  Install Bun via winget? (Y/N)"
    if ($ans -match "^[Yy]") {
        Write-Host "  >> Running winget..." -ForegroundColor Yellow
        winget install Oven-sh.Bun --source winget --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  OK Bun installed." -ForegroundColor Green
            Write-Host ""
            Write-Host "  Please close this window and run the updater again." -ForegroundColor Cyan
            Write-Host "  (PATH changes only take effect in a new session.)" -ForegroundColor DarkGray
        } else {
            Write-Host "  !! Winget failed. Install manually: https://bun.sh/" -ForegroundColor Red
        }
    } else {
        Write-Host "  Install manually: https://bun.sh/" -ForegroundColor DarkGray
    }
    Write-Host ""
    Read-Host "  Press Enter to exit"
    exit 1
}

& $bun scripts\update.ts @args

Write-Host ""

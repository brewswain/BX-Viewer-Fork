# BounceX Launcher
# Right-click -> "Run with PowerShell" or double-click if .ps1 is associated.
# Add -Dev to run the Next.js dev server instead of a production build.

param([switch]$Dev)

Set-Location $PSScriptRoot

function Step  { param($m) Write-Host "  >> $m" -ForegroundColor Yellow }
function Ok    { param($m) Write-Host "  OK $m" -ForegroundColor Green }
function Fail  { param($m) Write-Host "  !! $m" -ForegroundColor Red }
function Note  { param($m) Write-Host "     $m" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "  BounceX Launcher" -ForegroundColor Cyan
Write-Host ""

Step "Checking for Bun..."

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun -and (Test-Path "$env:USERPROFILE\.bun\bin\bun.exe")) {
    # Installed but not on PATH for this session yet.
    $bun = "$env:USERPROFILE\.bun\bin\bun.exe"
}

if ($bun) {
    $bunVersion = (& $bun --version 2>&1 | Select-Object -First 1)
    Ok "Found: Bun $bunVersion"
} else {
    Fail "Bun not found."
    Write-Host ""
    Note "Bun is the JavaScript runtime this app runs on."
    Note "It can be installed with:  winget install Oven-sh.Bun"
    Write-Host ""
    $ans = Read-Host "  Install Bun via winget? (Y/N)"
    if ($ans -match "^[Yy]") {
        Step "Running winget..."
        winget install Oven-sh.Bun --source winget --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) {
            Ok "Bun installed."
            Write-Host ""
            Write-Host "  Please close this window and run the script again." -ForegroundColor Cyan
            Write-Host "  (PATH changes only take effect in a new session.)" -ForegroundColor DarkGray
        } else {
            Fail "Winget failed. Install manually: https://bun.sh/"
            Note "Or run:  powershell -c ""irm bun.sh/install.ps1 | iex"""
        }
    } else {
        Write-Host "  Install manually: https://bun.sh/" -ForegroundColor DarkGray
        Note "Or run:  powershell -c ""irm bun.sh/install.ps1 | iex"""
    }
    Write-Host ""
    Read-Host "  Press Enter to exit"
    exit 1
}

if (-not (Test-Path "node_modules")) {
    # --frozen-lockfile writes no lockfile. That matters on exFAT drives, where a
    # plain `bun install` unpacks every package correctly but still exits 1 with
    # "Failed to replace old lockfile with new lockfile on disk" because exFAT has
    # no atomic replace. Fall back to a normal install if the lockfile is stale,
    # and only treat that as fatal when the packages genuinely did not land.
    Step "Installing dependencies (bun install --frozen-lockfile)..."
    & $bun install --frozen-lockfile | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Step "Lockfile does not match package.json - retrying without --frozen-lockfile..."
        & $bun install | Out-Host
        if ($LASTEXITCODE -ne 0 -and -not (Test-Path "node_modules\next")) {
            Fail "bun install failed."
            Read-Host "  Press Enter to exit"
            exit 1
        }
        if ($LASTEXITCODE -ne 0) {
            Note "bun could not rewrite bun.lock (exFAT has no atomic replace) - packages are fine."
        }
    }
    Ok "Dependencies installed."
}

$httpPort = 8000
try {
    $configRaw = Get-Content "config.json" -Raw | ConvertFrom-Json
    if ($configRaw.httpPort) { $httpPort = $configRaw.httpPort }
} catch { }
# managerPort is vestigial - the manager now lives at /manager on the same port.

$localIP = $null
try {
    $localIP = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Sort-Object PrefixLength |
        Select-Object -First 1).IPAddress
} catch { }
if (-not $localIP) { $localIP = "localhost" }

if (-not $Dev) {
    Step "Building the app (this can take a minute)..."
    & $bun run build | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Fail "Build failed."
        Read-Host "  Press Enter to exit"
        exit 1
    }
    Ok "Build complete."
}

Write-Host ""
Write-Host "  On your local network, open this URL on any device:" -ForegroundColor Cyan
Write-Host "  Home page  ->  http://${localIP}:$httpPort" -ForegroundColor Green
Write-Host "  This PC    ->  http://localhost:$httpPort" -ForegroundColor Green
Write-Host ""
Write-Host "  Press Ctrl+C to stop the server." -ForegroundColor DarkGray
Write-Host ""

$serverProc = $null

try {
    $startArgs = @{
        FilePath         = $bun
        ArgumentList     = @("run", $(if ($Dev) { "dev" } else { "start" }), "-p", "$httpPort")
        WorkingDirectory = $PSScriptRoot
        PassThru         = $true
    }
    # Dev mode shares this console so compile errors are visible; a production run
    # stays hidden, as the old two-process launcher did.
    if ($Dev) { $startArgs.NoNewWindow = $true } else { $startArgs.WindowStyle = "Hidden" }

    $serverProc = Start-Process @startArgs
    Ok "Server started (PID $($serverProc.Id))"

    Start-Process "http://localhost:$httpPort"

    while ($true) {
        Start-Sleep -Seconds 1
        if ($serverProc.HasExited) {
            Fail "Server exited unexpectedly (code $($serverProc.ExitCode))."
            break
        }
    }
} finally {
    Write-Host ""
    Step "Shutting down..."
    if ($serverProc -and -not $serverProc.HasExited) {
        # bun spawns next as a child process, so kill the whole tree.
        & taskkill.exe /PID $serverProc.Id /T /F 2>&1 | Out-Null
        if (-not $serverProc.HasExited) {
            Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
        }
        Ok "Server stopped."
    }
    Write-Host ""
    Read-Host "  Press Enter to exit"
}

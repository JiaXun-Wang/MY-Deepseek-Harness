# start-dsh-web.ps1
# DeepSeek Harness Web launcher.
#
# Starts the local `dsh web` server (default http://127.0.0.1:3080), waits
# until it responds, then opens the browser. Re-uses a running instance and,
# when 3080 is taken by another program, falls back to an OS-assigned port
# and opens that URL instead.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File start-dsh-web.ps1

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root

$HostPort = 3080
$Url      = "http://127.0.0.1:$HostPort"
$LogDir   = Join-Path $Root 'logs'
$LogFile  = Join-Path $LogDir 'dsh-web.log'
$CliBin   = Join-Path $Root 'apps\cli\lib\bin.js'
$Node     = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $Node) {
    Write-Host "[dsh-web] Node.js not found on PATH. Install Node.js 22/24 first." -ForegroundColor Red
    Start-Sleep -Seconds 5
    exit 1
}
if (-not (Test-Path -LiteralPath $CliBin)) {
    Write-Host "[dsh-web] CLI not built yet. Building now..." -ForegroundColor Yellow
    & pnpm.cmd run build 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[dsh-web] Build failed. Open a terminal in $Root and run: pnpm run build" -ForegroundColor Red
        Start-Sleep -Seconds 5
        exit 1
    }
}

function Test-Alive {
    param([string]$probeUrl)
    try {
        $resp = Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -Method Head -TimeoutSec 4 -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

# Already running on 3080? Just reveal it.
if (Test-Alive $Url) {
    Write-Host "[dsh-web] Server already running at $Url"
    Start-Process $Url
    exit 0
}

$port = $HostPort
# If 3080 is listening (but not answering), switch to an OS-assigned port.
$listener = Get-NetTCPConnection -LocalPort $HostPort -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Write-Host "[dsh-web] Port $HostPort is busy (PID $($listener[0].OwningProcess)); using an OS-assigned port."
    $port = 0
}

$null = New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$portArg = if ($port -eq 0) { @('--port', '0') } else { @() }
$argsList = @($CliBin, 'web') + $portArg

$logStream = Start-Process `
    -FilePath $Node `
    -ArgumentList $argsList `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $LogFile `
    -PassThru

Write-Host "[dsh-web] Starting server (PID $($logStream.Id)); log: $LogFile"

$ready = $false
$resolvedUrl = $null
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    if ($logStream.HasExited) {
        Write-Host "[dsh-web] Server exited early." -ForegroundColor Red
        if (Test-Path -LiteralPath $LogFile) { Get-Content -LiteralPath $LogFile -Tail 30 | Write-Host }
        Start-Sleep -Seconds 5
        exit 1
    }
    # Prefer 3080; otherwise read the OS-assigned port from the log banner.
    if (Test-Alive $Url) { $resolvedUrl = $Url; $ready = $true; break }
    if ($port -eq 0 -and -not $resolvedUrl -and (Test-Path -LiteralPath $LogFile)) {
        $m = [regex]::Match((Get-Content -LiteralPath $LogFile -Raw -ErrorAction SilentlyContinue), 'dsh web: (http://127\.0\.0\.1:\d+)')
        if ($m.Success) {
            $resolvedUrl = $m.Groups[1].Value
            if (Test-Alive $resolvedUrl) { $ready = $true; break }
        }
    }
}

if ($ready -and $resolvedUrl) {
    Write-Host "[dsh-web] Ready at $resolvedUrl — opening browser." -ForegroundColor Green
    Start-Process $resolvedUrl
} else {
    Write-Host "[dsh-web] Server did not become ready. See $LogFile" -ForegroundColor Yellow
}

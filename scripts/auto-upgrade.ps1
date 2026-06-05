# 由 sync agent 在发现新版本且空闲时拉起（detached）。
param(
  [string]$TargetVersion,
  [string]$CurrentVersion
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Log($msg) {
  Write-Host "[auto-upgrade] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
}

function Get-ManagementPort {
  $port = 9090
  $configPath = Join-Path $Root "config.json"
  if (Test-Path $configPath) {
    try {
      $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
      if ($null -ne $cfg.managementPort -and [int]$cfg.managementPort -gt 0) {
        $port = [int]$cfg.managementPort
      }
    } catch {
      Log "read config.json failed, use default port 9090"
    }
  }
  return $port
}

function Stop-SyncByPort([int]$Port) {
  $lines = netstat -ano | Select-String ":$Port\s+.*LISTENING"
  foreach ($line in $lines) {
    if ($line -match '\s(\d+)\s*$') {
      $procId = [int]$Matches[1]
      if ($procId -le 0) { continue }
      Log "Stopping process on port $Port (PID $procId)"
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-SyncDetached {
  $logDir = Join-Path $Root "logs"
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
  $logFile = Join-Path $logDir "auto-upgrade-restart.log"
  Log "Starting npm start (detached), log: $logFile"
  Start-Process -FilePath "npm" -ArgumentList "start" -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput $logFile -RedirectStandardError $logFile
}

Log "upgrade start current=$CurrentVersion target=$TargetVersion root=$Root"

$pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue
if ($pm2Cmd) {
  pm2 stop openclaw-xgkb-sync 2>$null
  Start-Sleep -Seconds 2
} else {
  Stop-SyncByPort (Get-ManagementPort)
  Start-Sleep -Seconds 2
}

git fetch --tags origin
$tag = "v$TargetVersion"
if (git rev-parse $tag 2>$null) {
  git checkout -f $tag
} elseif (git rev-parse $TargetVersion 2>$null) {
  git checkout -f $TargetVersion
} else {
  git pull origin main
  if ($LASTEXITCODE -ne 0) { git pull origin master }
}

npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if ($pm2) {
  pm2 restart openclaw-xgkb-sync
  if ($LASTEXITCODE -ne 0) {
    pm2 start dist/index.js --name openclaw-xgkb-sync -- --config config.json
  }
} else {
  Start-SyncDetached
}

Log "upgrade finished"

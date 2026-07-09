# 由 sync agent 在发现新版本且空闲时拉起（detached）。
param(
  [string]$TargetVersion,
  [string]$CurrentVersion
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$ServiceName = "openclaw-xgkb-sync"
$TaskName = "OpenClawXgkbSync"

$LogDir = Join-Path $Root "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir "auto-upgrade.log"
$RestartLog = Join-Path $LogDir "auto-upgrade-restart.log"

function Log($msg) {
  $line = "[auto-upgrade] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Resolve-NodeBin {
  if ($env:OPENCLAW_SYNC_NODE -and (Test-Path $env:OPENCLAW_SYNC_NODE)) {
    return $env:OPENCLAW_SYNC_NODE
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { return $node.Source }
  throw "node not found; set OPENCLAW_SYNC_NODE or fix PATH"
}

function Get-ManagementPort([string]$NodeBin) {
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
  Start-Sleep -Seconds 2
}

function Start-SyncDetached([string]$NodeBin, [int]$Port) {
  $dist = Join-Path $Root "dist\index.js"
  $config = Join-Path $Root "config.json"
  if (-not (Test-Path $dist)) {
    throw "dist/index.js missing (npm run build failed?)"
  }
  Log "Starting node dist/index.js (detached), service log: $RestartLog"
  Start-Process -FilePath $NodeBin -ArgumentList @("dist/index.js", "--config", $config) `
    -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput $RestartLog -RedirectStandardError $RestartLog
  Start-Sleep -Seconds 4
  $listening = netstat -ano | Select-String ":$Port\s+.*LISTENING"
  if ($listening) {
    Log "restart OK: port $Port is listening"
  } else {
    throw "restart FAILED: port $Port not listening; check $RestartLog"
  }
}

function Get-RuntimeMode {
  $pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
  if ($pm2) {
    $desc = pm2 describe $ServiceName 2>$null
    if ($LASTEXITCODE -eq 0) { return "pm2" }
  }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { return "scheduled-task" }
  return "port"
}

function Stop-ServiceRuntime([int]$Port) {
  switch ($script:RuntimeMode) {
    "pm2" {
      pm2 stop $ServiceName 2>$null
      Start-Sleep -Seconds 2
    }
    "scheduled-task" {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Stop-SyncByPort $Port
    }
    default {
      Stop-SyncByPort $Port
    }
  }
}

function Start-ServiceRuntime([string]$NodeBin, [int]$Port) {
  switch ($script:RuntimeMode) {
    "pm2" {
      pm2 restart $ServiceName
      if ($LASTEXITCODE -ne 0) {
        pm2 start dist/index.js --name $ServiceName -- --config config.json
      }
    }
    "scheduled-task" {
      Start-ScheduledTask -TaskName $TaskName
      Start-Sleep -Seconds 4
      $listening = netstat -ano | Select-String ":$Port\s+.*LISTENING"
      if (-not $listening) {
        throw "scheduled task started but port $Port not listening"
      }
    }
    default {
      Start-SyncDetached $NodeBin $Port
    }
  }
}

try {
  Log "======== upgrade start current=$CurrentVersion target=$TargetVersion root=$Root ========"
  $nodeBin = Resolve-NodeBin
  Log "using node: $nodeBin"
  $mgmtPort = Get-ManagementPort $nodeBin

  $script:RuntimeMode = Get-RuntimeMode
  Log "detected runtime: $RuntimeMode"
  Stop-ServiceRuntime $mgmtPort

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

  npm install --include=dev
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

  Start-ServiceRuntime $nodeBin $mgmtPort

  Log "======== upgrade finished ========"
} catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}

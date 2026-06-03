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

Log "开始升级 current=$CurrentVersion target=$TargetVersion root=$Root"

$pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue
if ($pm2Cmd) {
  pm2 stop openclaw-xgkb-sync 2>$null
  Start-Sleep -Seconds 2
} else {
  Log "未检测到 pm2，请确保同步进程已停止后再升级"
}

git fetch --tags origin
$tag = "v$TargetVersion"
if (git rev-parse $tag 2>$null) {
  git checkout $tag
} elseif (git rev-parse $TargetVersion 2>$null) {
  git checkout $TargetVersion
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
  Log "未检测到 pm2，请手动执行: npm start"
}

Log "升级流程结束"

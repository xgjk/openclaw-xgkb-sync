# 注册 Windows 登录自启任务 + 立即启动服务
# 用法（管理员非必须，当前用户）:
#   powershell -ExecutionPolicy Bypass -File .\deploy\windows\install-autostart.ps1
param(
  [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"
$TaskName = "OpenClawXgkbSync"

function Log($msg) { Write-Host "[install-windows] $msg" -ForegroundColor Cyan }

if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
$ProjectRoot = (Resolve-Path $ProjectRoot).Path

$nodeBin = $env:OPENCLAW_SYNC_NODE
if (-not $nodeBin) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw "未找到 node，请先安装 Node.js LTS (>= 18)" }
  $nodeBin = $nodeCmd.Source
}

Log "项目目录: $ProjectRoot"
Log "Node: $nodeBin"

Set-Location $ProjectRoot

Log "安装依赖并编译..."
npm install --include=dev
if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build 失败" }

$dist = Join-Path $ProjectRoot "dist\index.js"
$config = Join-Path $ProjectRoot "config.json"
if (-not (Test-Path $dist)) { throw "dist\index.js 不存在" }

$logsDir = Join-Path $ProjectRoot "logs"
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }

# 停止已有任务与进程
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$port = 9090
if (Test-Path $config) {
  try {
    $cfg = Get-Content $config -Raw | ConvertFrom-Json
    if ($null -ne $cfg.managementPort -and [int]$cfg.managementPort -gt 0) {
      $port = [int]$cfg.managementPort
    }
  } catch { }
}

$lines = netstat -ano | Select-String ":$port\s+.*LISTENING"
foreach ($line in $lines) {
  if ($line -match '\s(\d+)\s*$') {
    $procId = [int]$Matches[1]
    if ($procId -gt 0) {
      Log "停止占用端口 $port 的进程 PID $procId"
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
  }
}

$action = New-ScheduledTaskAction `
  -Execute $nodeBin `
  -Argument "dist/index.js --config `"$config`" --log-file `"$logsDir\service.log`"" `
  -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "OpenClaw XGKB Sync Agent" | Out-Null
Log "已注册计划任务: $TaskName（用户登录时启动）"

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4

$listening = netstat -ano | Select-String ":$port\s+.*LISTENING"
if ($listening) {
  Log "服务已监听端口 $port"
} else {
  throw "端口 $port 未监听，请查看 $logsDir\service.log"
}

try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 5
  if ($r.StatusCode -eq 200) { Log "健康检查通过" }
} catch {
  Log "健康检查未通过，请稍后重试"
}

Log "完成。查看任务: Get-ScheduledTask -TaskName $TaskName"
Log "手动升级: git pull; npm install --include=dev; npm run build; Stop-ScheduledTask $TaskName; Start-ScheduledTask $TaskName"
Log "自动升级: config.json 保持 autoUpgradeEnabled=true，心跳空闲时执行 scripts/auto-upgrade.ps1"

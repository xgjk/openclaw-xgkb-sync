# 发版打 Git Tag（Windows 一键）
# 用法:
#   .\scripts\release-tag.ps1 -Push
#   .\scripts\release-tag.ps1 -Version 1.0.6 -Push
#   .\scripts\release-tag.ps1 -Version 1.0.6 -Force -Push

param(
  [string]$Version = "",
  [switch]$Push,
  [switch]$Force,
  [switch]$SkipCommit
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Log($msg) { Write-Host "[release-tag] $msg" -ForegroundColor Cyan }

$pkgPath = Join-Path $Root "package.json"
if (-not (Test-Path $pkgPath)) { throw "未找到 package.json: $pkgPath" }

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$current = [string]$pkg.version

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = $current
  Log "未指定 -Version，使用 package.json: $Version"
} else {
  $Version = $Version.Trim()
  if ($Version -match '^v') { $Version = $Version.Substring(1) }
  if ($Version -ne $current) {
    Log "更新 package.json version: $current -> $Version"
    $raw = Get-Content $pkgPath -Raw
    $raw = $raw -replace ('"version"\s*:\s*"' + [regex]::Escape($current) + '"'), ('"version": "' + $Version + '"')
    if ($raw -notmatch '"version"\s*:\s*"' + [regex]::Escape($Version) + '"') {
      throw "无法更新 package.json 中的 version 字段"
    }
    Set-Content -Path $pkgPath -Value $raw -NoNewline -Encoding utf8
  }
}

if ($Version -notmatch '^\d+\.\d+\.\d+') {
  throw "版本号格式应为 主.次.修订，例如 1.0.6，当前: $Version"
}

$tag = "v$Version"

git rev-parse --git-dir 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw "当前目录不是 git 仓库" }

$status = git status --porcelain
if ($status -and -not $Force) {
  Write-Host $status
  throw "工作区有未提交变更。请先提交或使用 -Force"
}

if (-not $SkipCommit) {
  $diff = git diff --name-only
  $staged = git diff --cached --name-only
  $needsCommit = @($diff; $staged) | Where-Object { $_ -match 'package\.json' }
  if ($needsCommit) {
    git add package.json
    git commit -m "chore: release $Version"
    if ($LASTEXITCODE -ne 0) { throw "git commit 失败" }
    Log "已提交 package.json"
  }
}

$exists = git tag -l $tag
if ($exists) {
  if (-not $Force) { throw "Tag $tag 已存在，使用 -Force 覆盖需先: git tag -d $tag" }
  git tag -d $tag | Out-Null
}

git tag -a $tag -m "release $Version"
if ($LASTEXITCODE -ne 0) { throw "git tag 失败" }
Log "已创建 tag: $tag"

if ($Push) {
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  Log "推送分支 $branch 与 tag $tag ..."
  git push origin $branch
  if ($LASTEXITCODE -ne 0) { throw "git push 分支失败" }
  git push origin $tag
  if ($LASTEXITCODE -ne 0) { throw "git push tag 失败" }
  Log "推送完成"
} else {
  Log "未推送。若要推送请加: -Push"
  Log "  git push origin HEAD"
  Log "  git push origin $tag"
}

Log "发版 Tag 就绪: $tag （请在 Nacos 设置 openclaw.sync.latest-version = $Version）"

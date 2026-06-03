#!/usr/bin/env bash
# 发版打 Git Tag（Linux/macOS 一键）
# 用法:
#   ./scripts/release-tag.sh --push
#   ./scripts/release-tag.sh --version 1.0.6 --push
#   ./scripts/release-tag.sh --version 1.0.6 --force --push

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION=""
PUSH=false
FORCE=false
SKIP_COMMIT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|-v) VERSION="${2:-}"; shift 2 ;;
    --push) PUSH=true; shift ;;
    --force|-f) FORCE=true; shift ;;
    --skip-commit) SKIP_COMMIT=true; shift ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

log() { echo "[release-tag] $*"; }

PKG="$ROOT/package.json"
[[ -f "$PKG" ]] || { echo "未找到 package.json"; exit 1; }

current="$(node -p "require('./package.json').version")"

if [[ -z "$VERSION" ]]; then
  VERSION="$current"
  log "未指定 --version，使用 package.json: $VERSION"
else
  VERSION="${VERSION#v}"
  if [[ "$VERSION" != "$current" ]]; then
    log "更新 package.json version: $current -> $VERSION"
    node -e "
      const fs=require('fs');
      const p='$PKG';
      const j=JSON.parse(fs.readFileSync(p,'utf8'));
      j.version='$VERSION';
      fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
    "
  fi
fi

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本号格式应为 主.次.修订: $VERSION"; exit 1; }

TAG="v$VERSION"
git rev-parse --git-dir >/dev/null

if [[ -n "$(git status --porcelain)" && "$FORCE" != true ]]; then
  git status --short
  echo "工作区有未提交变更。请先提交或使用 --force"
  exit 1
fi

if [[ "$SKIP_COMMIT" != true ]]; then
  if git diff --name-only | grep -q package.json || git diff --cached --name-only | grep -q package.json; then
    git add package.json
    git commit -m "chore: release $VERSION"
    log "已提交 package.json"
  fi
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  if [[ "$FORCE" != true ]]; then
    echo "Tag $TAG 已存在，使用 --force 或先: git tag -d $TAG"
    exit 1
  fi
  git tag -d "$TAG"
fi

git tag -a "$TAG" -m "release $VERSION"
log "已创建 tag: $TAG"

if [[ "$PUSH" == true ]]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  log "推送分支 $branch 与 tag $TAG ..."
  git push origin "$branch"
  git push origin "$TAG"
  log "推送完成"
else
  log "未推送。若要推送请加: --push"
fi

log "发版 Tag 就绪: $TAG （请在 Nacos 设置 openclaw.sync.latest-version = $VERSION）"

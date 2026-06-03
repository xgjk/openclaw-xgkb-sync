#!/usr/bin/env bash
# 由 sync agent 在发现新版本且空闲时拉起（detached）。
# 用法: ./scripts/auto-upgrade.sh <targetVersion> <currentVersion>
set -euo pipefail

TARGET="${1:-}"
CURRENT="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { echo "[auto-upgrade] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

log "开始升级 current=${CURRENT} target=${TARGET} root=${ROOT}"

# 1) 停服（避免占用 dist/node_modules）
if command -v pm2 >/dev/null 2>&1; then
  pm2 stop openclaw-xgkb-sync >/dev/null 2>&1 || true
  sleep 2
elif systemctl is-active --quiet openclaw-xgkb-sync 2>/dev/null; then
  sudo systemctl stop openclaw-xgkb-sync
  sleep 2
else
  log "未检测到 pm2/systemd，请确保同步进程已停止后再升级"
fi

# 2) 拉代码并构建（与 docs/INSTALL_AND_UPDATE.md 一致）
git fetch --tags origin
if git rev-parse "v${TARGET}" >/dev/null 2>&1; then
  git checkout "v${TARGET}"
elif git rev-parse "${TARGET}" >/dev/null 2>&1; then
  git checkout "${TARGET}"
else
  git pull origin main || git pull origin master
fi

npm install
npm run build

# 3) 由进程管理器拉起（按环境选择其一）
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart openclaw-xgkb-sync || pm2 start dist/index.js --name openclaw-xgkb-sync -- --config config.json
elif systemctl is-active --quiet openclaw-xgkb-sync 2>/dev/null; then
  sudo systemctl restart openclaw-xgkb-sync
else
  log "未检测到 pm2/systemd，请手动执行: npm start"
  exit 0
fi

log "升级流程结束"

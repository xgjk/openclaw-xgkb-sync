#!/usr/bin/env bash
# 由 sync agent 在发现新版本且空闲时拉起（detached）。
# 用法: ./scripts/auto-upgrade.sh <targetVersion> <currentVersion>
set -euo pipefail

TARGET="${1:-}"
CURRENT="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { echo "[auto-upgrade] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

read_management_port() {
  local port=9090
  if [[ -f config.json ]]; then
    port="$(node -e "try{const c=require('./config.json');process.stdout.write(String(c.managementPort>0?c.managementPort:9090))}catch(e){process.stdout.write('9090')}" 2>/dev/null || echo 9090)"
  fi
  echo "$port"
}

stop_sync_by_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti:"$port" 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      log "Stopping process(es) on port $port: $pids"
      kill $pids 2>/dev/null || true
    fi
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  else
    log "lsof/fuser not found; ensure sync process is stopped before upgrade"
  fi
}

start_sync_detached() {
  mkdir -p logs
  log "Starting npm start (nohup), log: logs/auto-upgrade-restart.log"
  nohup npm start >> logs/auto-upgrade-restart.log 2>&1 &
}

log "upgrade start current=${CURRENT} target=${TARGET} root=${ROOT}"

if command -v pm2 >/dev/null 2>&1; then
  pm2 stop openclaw-xgkb-sync >/dev/null 2>&1 || true
  sleep 2
elif systemctl is-active --quiet openclaw-xgkb-sync 2>/dev/null; then
  sudo systemctl stop openclaw-xgkb-sync
  sleep 2
else
  stop_sync_by_port "$(read_management_port)"
  sleep 2
fi

git fetch --tags origin
if git rev-parse "v${TARGET}" >/dev/null 2>&1; then
  git checkout -f "v${TARGET}"
elif git rev-parse "${TARGET}" >/dev/null 2>&1; then
  git checkout -f "${TARGET}"
else
  git pull origin main || git pull origin master
fi

npm install
npm run build

if command -v pm2 >/dev/null 2>&1; then
  pm2 restart openclaw-xgkb-sync || pm2 start dist/index.js --name openclaw-xgkb-sync -- --config config.json
elif systemctl is-active --quiet openclaw-xgkb-sync 2>/dev/null; then
  sudo systemctl restart openclaw-xgkb-sync
else
  start_sync_detached
fi

log "upgrade finished"

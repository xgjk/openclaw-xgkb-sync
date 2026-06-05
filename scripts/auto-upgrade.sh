#!/usr/bin/env bash
# 由 sync agent 在发现新版本且空闲时拉起（detached）。
# 用法: ./scripts/auto-upgrade.sh <targetVersion> <currentVersion>
set -euo pipefail

TARGET="${1:-}"
CURRENT="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p logs
LOG_FILE="$ROOT/logs/auto-upgrade.log"
RESTART_LOG="$ROOT/logs/auto-upgrade-restart.log"
exec >> "$LOG_FILE" 2>&1

log() { echo "[auto-upgrade] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

resolve_node_bin() {
  if [[ -n "${OPENCLAW_SYNC_NODE:-}" && -x "${OPENCLAW_SYNC_NODE}" ]]; then
    echo "${OPENCLAW_SYNC_NODE}"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  return 1
}

setup_path_for_node() {
  local node_bin="$1"
  export PATH="$(dirname "$node_bin"):${PATH:-}"
  log "using node: $node_bin ($( "$node_bin" -v 2>/dev/null || echo unknown ))"
}

read_management_port() {
  local port=9090
  local node_bin="$1"
  if [[ -f config.json ]]; then
    port="$("$node_bin" -e "try{const c=require('./config.json');process.stdout.write(String(c.managementPort>0?c.managementPort:9090))}catch(e){process.stdout.write('9090')}" 2>/dev/null || echo 9090)"
  fi
  echo "$port"
}

stop_sync_by_port() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    log "lsof not found; ensure sync process is stopped before upgrade"
    return 0
  fi
  local pids
  pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    log "no process listening on port $port"
    return 0
  fi
  log "Stopping process(es) on port $port: $pids"
  kill -TERM $pids 2>/dev/null || true
  sleep 3
  pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    log "force kill remaining on port $port: $pids"
    kill -KILL $pids 2>/dev/null || true
    sleep 1
  fi
}

start_sync_detached() {
  local node_bin="$1"
  local port="$2"
  local config_path="$ROOT/config.json"
  if [[ ! -f "$ROOT/dist/index.js" ]]; then
    log "restart FAILED: dist/index.js missing (npm run build failed?)"
    exit 1
  fi
  log "Starting node dist/index.js (nohup), service log: $RESTART_LOG"
  nohup "$node_bin" dist/index.js --config "$config_path" >> "$RESTART_LOG" 2>&1 &
  local new_pid=$!
  log "spawned pid=$new_pid, waiting for port $port..."
  sleep 4
  if lsof -ti:"$port" >/dev/null 2>&1; then
    log "restart OK: port $port is listening"
  else
    log "restart FAILED: port $port not listening; check $RESTART_LOG and $LOG_FILE"
    exit 1
  fi
}

log "======== upgrade start current=${CURRENT} target=${TARGET} root=${ROOT} ========"

NODE_BIN="$(resolve_node_bin)" || { log "node not found; set OPENCLAW_SYNC_NODE or fix PATH"; exit 1; }
setup_path_for_node "$NODE_BIN"
MGMT_PORT="$(read_management_port "$NODE_BIN")"

if command -v pm2 >/dev/null 2>&1; then
  pm2 stop openclaw-xgkb-sync >/dev/null 2>&1 || true
  sleep 2
elif systemctl is-active --quiet openclaw-xgkb-sync 2>/dev/null; then
  sudo systemctl stop openclaw-xgkb-sync
  sleep 2
else
  stop_sync_by_port "$MGMT_PORT"
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
  start_sync_detached "$NODE_BIN" "$MGMT_PORT"
fi

log "======== upgrade finished ========"

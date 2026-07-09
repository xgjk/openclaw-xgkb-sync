#!/usr/bin/env bash
# Docker 部署专用自动升级：git 拉取 + build 后结束监听进程，由 restart: unless-stopped 拉起新容器进程。
# 配置：config.json 中 autoUpgradeScript 设为 "./scripts/auto-upgrade.docker.sh"
# 用法: ./scripts/auto-upgrade.docker.sh <targetVersion> <currentVersion>
set -euo pipefail

TARGET="${1:-}"
CURRENT="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p logs
LOG_FILE="$ROOT/logs/auto-upgrade.log"
exec >> "$LOG_FILE" 2>&1

log() { echo "[auto-upgrade-docker] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

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
    log "lsof not found; cannot stop listener on port $port"
    return 1
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

log "======== docker upgrade start current=${CURRENT} target=${TARGET} root=${ROOT} ========"

if ! command -v git >/dev/null 2>&1; then
  log "git not found in container; use host: git pull && docker compose up -d --build"
  exit 1
fi

NODE_BIN="$(resolve_node_bin)" || { log "node not found"; exit 1; }
export PATH="$(dirname "$NODE_BIN"):${PATH:-}"
MGMT_PORT="$(read_management_port "$NODE_BIN")"

git fetch --tags origin
if git rev-parse "v${TARGET}" >/dev/null 2>&1; then
  git checkout -f "v${TARGET}"
elif git rev-parse "${TARGET}" >/dev/null 2>&1; then
  git checkout -f "${TARGET}"
else
  git pull origin main || git pull origin master
fi

npm install --include=dev
npm run build

if stop_sync_by_port "$MGMT_PORT"; then
  log "listener stopped; container should restart via Docker restart policy"
else
  log "could not stop listener; run manually: docker compose restart openclaw-xgkb-sync"
  exit 1
fi

log "======== docker upgrade finished ========"

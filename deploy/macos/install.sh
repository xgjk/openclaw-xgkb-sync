#!/usr/bin/env bash
# 安装 macOS LaunchAgent（用户登录后自启，KeepAlive 崩溃自动拉起）
# 用法: ./deploy/macos/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LABEL="com.openclaw.xgkb-sync"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/${LABEL}.plist"
TEMPLATE="$SCRIPT_DIR/${LABEL}.plist.template"

log() { echo "[install-macos] $*"; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此脚本仅适用于 macOS" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "未找到 node，请先安装 Node.js >= 18（brew install node 或 nvm）" >&2
  exit 1
fi

cd "$ROOT"
log "项目目录: $ROOT"
log "Node: $NODE_BIN ($("$NODE_BIN" -v))"

log "安装依赖并编译..."
npm install --include=dev
npm run build

mkdir -p "$PLIST_DIR" "$ROOT/logs" "$HOME/Library/Logs"

sed \
  -e "s|@ROOT@|${ROOT}|g" \
  -e "s|@NODE@|${NODE_BIN}|g" \
  -e "s|@HOME@|${HOME}|g" \
  "$TEMPLATE" > "$PLIST_PATH"

log "已写入 $PLIST_PATH"

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN" "$PLIST_PATH" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null || true
if launchctl bootstrap "$DOMAIN" "$PLIST_PATH" 2>/dev/null; then
  :
else
  launchctl load "$PLIST_PATH"
fi

sleep 3
PORT="$("$NODE_BIN" -e "try{const c=require('./config.json');process.stdout.write(String(c.managementPort>0?c.managementPort:9090))}catch(e){process.stdout.write('9090')}" 2>/dev/null || echo 9090)"
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  log "服务已监听端口 $PORT"
else
  log "端口 $PORT 未监听，请查看 ~/Library/Logs/openclaw-xgkb-sync.stderr.log"
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null && log "健康检查通过" || log "健康检查未通过，请稍后重试"
fi

log "完成。状态: launchctl print $DOMAIN/$LABEL"
log "手动升级: git pull && npm install --include=dev && npm run build && launchctl kickstart -k $DOMAIN/$LABEL"

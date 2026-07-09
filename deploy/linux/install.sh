#!/usr/bin/env bash
# 安装 Linux 用户级 systemd 服务（开机自启，升级无需 sudo）
# 用法: ./deploy/linux/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVICE_NAME="openclaw-xgkb-sync"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/${SERVICE_NAME}.service"
TEMPLATE="$SCRIPT_DIR/${SERVICE_NAME}.service.template"

log() { echo "[install-linux] $*"; }

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "此脚本仅适用于 Linux" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "未找到 node，请先安装 Node.js >= 18" >&2
  exit 1
fi

cd "$ROOT"
log "项目目录: $ROOT"
log "Node: $NODE_BIN ($("$NODE_BIN" -v))"

log "安装依赖并编译..."
npm install --include=dev
npm run build

mkdir -p "$UNIT_DIR" "$ROOT/logs"

sed \
  -e "s|@ROOT@|${ROOT}|g" \
  -e "s|@NODE@|${NODE_BIN}|g" \
  "$TEMPLATE" > "$UNIT_PATH"

log "已写入 $UNIT_PATH"

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"

if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" 2>/dev/null || log "提示: 若需未登录也自启，请执行: loginctl enable-linger $USER"
fi

sleep 2
if systemctl --user is-active --quiet "$SERVICE_NAME"; then
  log "服务已运行。状态: systemctl --user status $SERVICE_NAME"
  log "日志: journalctl --user -u $SERVICE_NAME -f"
else
  log "服务未处于 active，请检查: journalctl --user -u $SERVICE_NAME -n 50"
  exit 1
fi

PORT="$("$NODE_BIN" -e "try{const c=require('./config.json');process.stdout.write(String(c.managementPort>0?c.managementPort:9090))}catch(e){process.stdout.write('9090')}" 2>/dev/null || echo 9090)"
if command -v curl >/dev/null 2>&1; then
  curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null && log "健康检查通过: http://127.0.0.1:${PORT}/health" || log "健康检查未通过，请稍后重试"
fi

log "完成。手动升级: git pull && npm install --include=dev && npm run build && systemctl --user restart $SERVICE_NAME"
log "自动升级: config.json 保持 autoUpgradeEnabled=true（默认），心跳空闲时执行 scripts/auto-upgrade.sh"

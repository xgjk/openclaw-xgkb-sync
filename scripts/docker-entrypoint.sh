#!/usr/bin/env bash
# Docker 容器入口：安装依赖、编译、前台运行 sync 进程（便于 restart 策略与升级后自动拉起）
set -euo pipefail

cd /app

CONFIG="${OPENCLAW_SYNC_CONFIG:-/app/config.json}"

install_and_build() {
  if [[ "${OPENCLAW_SYNC_SKIP_NPM_INSTALL:-}" != "1" ]]; then
    echo "[docker-entrypoint] npm install (含 devDependencies，build 需要 typescript)..."
    # compose 中 NODE_ENV=production 会使默认 npm install 跳过 devDependencies，导致 tsc 不存在
    npm install --silent --include=dev
  fi
  echo "[docker-entrypoint] npm run build..."
  npm run build
}

start_sync() {
  if [[ ! -f dist/index.js ]]; then
    echo "[docker-entrypoint] dist/index.js 不存在，请先完成 build" >&2
    exit 1
  fi
  echo "[docker-entrypoint] 启动 sync 服务，config=${CONFIG}"
  exec node dist/index.js --config "$CONFIG"
}

case "${1:-start}" in
  start)
    install_and_build
    start_sync
    ;;
  build-only)
    install_and_build
    ;;
  *)
    exec "$@"
    ;;
esac

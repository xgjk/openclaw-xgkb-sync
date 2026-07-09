# 开机自启与升级（裸机部署）

面向 **Linux / macOS / Windows**，不依赖 Docker。一键安装后：

- **开机（或登录）自动启动** sync 服务
- **手动升级**：`git pull` → `npm install --include=dev` → `npm run build` → 重启服务
- **自动升级**（可选）：`config.json` 中 `autoUpgradeEnabled: true`（默认），中心心跳发现新版本且同步空闲时执行 `scripts/auto-upgrade.sh` / `.ps1`

## 首次安装

```bash
git clone https://github.com/xgjk/openclaw-xgkb-sync.git
cd openclaw-xgkb-sync
npm install --include=dev
npm run build
# 浏览器打开 http://127.0.0.1:9090/ 配置 AppKey 与 mapping
```

然后按平台执行 **一条** 安装命令：

| 平台 | 命令 |
|------|------|
| **Linux** | `bash deploy/linux/install.sh` |
| **macOS** | `bash deploy/macos/install.sh` |
| **Windows** | `powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1` |

安装脚本会：编译项目 → 注册系统服务/计划任务 → 启动并做健康检查。

## 各平台说明

### Linux（systemd 用户服务）

- 单元文件：`~/.config/systemd/user/openclaw-xgkb-sync.service`
- 未登录也自启：`loginctl enable-linger $USER`（安装脚本会尝试执行）
- 常用命令：
  ```bash
  systemctl --user status openclaw-xgkb-sync
  journalctl --user -u openclaw-xgkb-sync -f
  systemctl --user restart openclaw-xgkb-sync
  ```

### macOS（LaunchAgent）

- plist：`~/Library/LaunchAgents/com.openclaw.xgkb-sync.plist`
- 用户登录后自启，`KeepAlive` 崩溃自动拉起
- 常用命令：
  ```bash
  launchctl print gui/$(id -u)/com.openclaw.xgkb-sync
  tail -f ~/Library/Logs/openclaw-xgkb-sync.stderr.log
  launchctl kickstart -k gui/$(id -u)/com.openclaw.xgkb-sync
  ```

### Windows（任务计划程序）

- 任务名：`OpenClawXgkbSync`（当前用户**登录时**启动）
- 常用命令：
  ```powershell
  Get-ScheduledTask -TaskName OpenClawXgkbSync
  Stop-ScheduledTask -TaskName OpenClawXgkbSync
  Start-ScheduledTask -TaskName OpenClawXgkbSync
  ```

## 手动升级

```bash
cd openclaw-xgkb-sync
git pull origin main
npm install --include=dev
npm run build
# Linux:  systemctl --user restart openclaw-xgkb-sync
# macOS:  launchctl kickstart -k gui/$(id -u)/com.openclaw.xgkb-sync
# Windows: Stop-ScheduledTask OpenClawXgkbSync; Start-ScheduledTask OpenClawXgkbSync
```

`config.json` 与 `openclaw-sync-state.db` 不会被 `git pull` 覆盖。

## 自动升级

前提：

1. **git clone** 安装（非纯 zip 拷贝）
2. 私有仓库已配置 Deploy Key / PAT（见 `docs/INSTALL_AND_UPDATE.md`）
3. `autoUpgradeEnabled: true`（默认）
4. 中心 Nacos `openclaw.sync.latest-version` 已更新

`auto-upgrade` 脚本会识别 pm2 → systemd（用户/系统）→ launchd → Windows 计划任务 → 按端口停进程并后台拉起。

日志：`logs/auto-upgrade.log`

## 可选：PM2（三平台通用）

若已使用 PM2，安装脚本可跳过；`pm2 startup` + `pm2 save` 同样支持开机自启，自动升级脚本会优先 `pm2 restart openclaw-xgkb-sync`。

```bash
npm run build
pm2 start dist/index.js --name openclaw-xgkb-sync -- --config config.json
pm2 save
pm2 startup   # 按提示执行生成的命令
```

更多细节见 [docs/DEPLOY_OPS_SOP.md](../docs/DEPLOY_OPS_SOP.md)（运维上线 SOP）与 [docs/INSTALL_AND_UPDATE.md](../docs/INSTALL_AND_UPDATE.md)。

# openclaw-xgkb-sync 节点上线与运维 SOP

**适用版本**：>= v1.1.7  
**受众**：运维 / 部署人员  
**目标**：节点可访问、**开机或登录后自启**、支持**手动与自动升级**

---

## 1. 适用范围

| 部署形态 | 本 SOP |
|----------|--------|
| Linux 裸机 | ✅ 推荐（systemd 用户服务） |
| macOS 裸机 | ✅ 推荐（LaunchAgent，登录后自启） |
| Windows 裸机 | ✅ 推荐（计划任务，登录后自启） |
| Docker | 可选，见 `docs/INSTALL_AND_UPDATE.md` §七 |

---

## 2. 前置条件（每个节点）

| 项 | 要求 |
|----|------|
| Node.js | >= 18（`node -v`） |
| Git | 已安装，能 `git fetch` |
| 仓库 | `git clone`（**禁止**仅拷贝 zip，否则无法自动升级） |
| 私有仓库 | 已配置 Deploy Key 或 HTTPS PAT（见 `docs/INSTALL_AND_UPDATE.md`「私有仓库认证」） |
| 网络 | 能访问知识库 Open API、`managementPort`（默认 9090） |
| 磁盘 | 项目目录 + mapping `localRoot` 工作区有足够空间 |

---

## 3. 新节点上线（一次性）

### 3.1 克隆与首次构建

```bash
git clone https://github.com/xgjk/openclaw-xgkb-sync.git
# 私有仓库 SSH 示例：
# git clone git@github.com:xgjk/openclaw-xgkb-sync.git

cd openclaw-xgkb-sync
git checkout v1.1.7   # 或更新后的目标 tag
npm install --include=dev
npm run build
npm start             # 临时前台启动，用于首次配置
```

Windows PowerShell 将 `bash` 命令改为对应路径即可。

### 3.2 Web 控制台首次配置

1. 浏览器打开 `http://127.0.0.1:9090/`
2. **全局配置**：填写 `appKey`，保存（触发热重载）
3. **同步映射**：新增 mapping（`localRoot` 绝对路径、`remoteRootFolderPath`、启用）
4. 点击 **同步**，确认「运行状态」无报错

### 3.3 多网卡 / 中心登记 nodeId（按需）

若机器多网卡或中心需稳定节点 ID，编辑 `config.json`：

```json
{
  "nodeAdvertiseIp": "192.168.x.x",
  "managementPort": 9090
}
```

保存后在 Web 控制台点击 **重载配置**，或重启服务。

### 3.4 注册开机/登录自启（必做）

**停止**上一步的临时 `npm start`（Ctrl+C），再执行**一条**平台命令：

| 平台 | 命令 |
|------|------|
| **Linux** | `bash deploy/linux/install.sh` |
| **macOS** | `bash deploy/macos/install.sh` |
| **Windows** | `powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1` |

脚本会：编译 → 注册服务 → 启动 → 健康检查。

**Linux 补充**（需未登录也自启时）：

```bash
loginctl enable-linger $USER
systemctl --user is-enabled openclaw-xgkb-sync
```

---

## 4. 上线验收（必做）

### 4.1 健康检查

```bash
curl http://127.0.0.1:9090/health
# Windows: curl.exe http://127.0.0.1:9090/health
```

期望：`"ok": true`。

### 4.2 服务状态

```bash
# Linux
systemctl --user status openclaw-xgkb-sync

# macOS
launchctl print gui/$(id -u)/com.openclaw.xgkb-sync

# Windows
Get-ScheduledTask -TaskName OpenClawXgkbSync
```

### 4.3 重启/登录验证（必做）

| 平台 | 操作 |
|------|------|
| Linux | `sudo reboot`，重启后 **不登录** 或登录后检查 `/health` |
| macOS | 注销再登录，或重启后登录，检查 `/health` |
| Windows | 注销再登录，或重启后登录，检查 `/health` |

### 4.4 业务验证

- Web 控制台 mapping 状态正常
- 试跑 **全部同步** 成功
- 若接入中心：节点在 sync-manage 可见，nodeId 正确

---

## 5. 日常升级

### 5.1 手动升级（推荐发版后首批节点验证）

```bash
cd openclaw-xgkb-sync
git fetch --tags origin
git checkout vX.Y.Z          # 目标版本 tag
npm install --include=dev
npm run build
```

按平台重启：

```bash
# Linux
systemctl --user restart openclaw-xgkb-sync

# macOS
launchctl kickstart -k gui/$(id -u)/com.openclaw.xgkb-sync

# Windows
Stop-ScheduledTask -TaskName OpenClawXgkbSync
Start-ScheduledTask -TaskName OpenClawXgkbSync
```

验收：`curl http://127.0.0.1:9090/health`，Web 控制台版本与映射正常。

**勿覆盖**：`config.json`、`openclaw-sync-state.db`、`logs/`。

### 5.2 自动升级（批量节点）

**中心侧**：Nacos `openclaw.sync.latest-version` = 目标版本（如 `1.1.7`）。

**节点侧**（默认已满足）：

- `config.json` → `"autoUpgradeEnabled": true`
- Git 认证可用
- 节点同步空闲时，心跳触发 `scripts/auto-upgrade.sh` / `.ps1`

日志：`logs/auto-upgrade.log`。

自动升级会识别 pm2 / systemd / launchd / Windows 计划任务并重启，**无需**每台手工 restart（除非升级失败）。

---

## 6. 常见问题

| 现象 | 处理 |
|------|------|
| 重启后服务未起来 | 是否执行过 `deploy/*/install.*`？Mac/Win 是否已**登录**？ |
| Linux 未登录不自启 | `loginctl enable-linger $USER` |
| 自动升级不触发 | 查 Nacos 版本号、Git 认证、`autoUpgradeEnabled`、是否在同步中 |
| `git pull` 要密码 | 配置 Deploy Key / PAT |
| 端口占用 | 改 `managementPort` 后**重启服务**（非仅热重载） |
| 监听显示「未运行」 | 新建 mapping 后 v1.1.4+ 会自动建 `localRoot`；旧 mapping 可点「重载配置」 |

---

## 7. 命令速查卡

```
项目目录:  /path/to/openclaw-xgkb-sync
健康检查:  curl http://127.0.0.1:9090/health
管理界面:  http://127.0.0.1:9090/

Linux  状态: systemctl --user status openclaw-xgkb-sync
Linux  日志: journalctl --user -u openclaw-xgkb-sync -f
Linux  重启: systemctl --user restart openclaw-xgkb-sync

macOS  重启: launchctl kickstart -k gui/$(id -u)/com.openclaw.xgkb-sync
macOS  日志: tail -f ~/Library/Logs/openclaw-xgkb-sync.stderr.log

Win    任务: Get-ScheduledTask -TaskName OpenClawXgkbSync
Win    重启: Stop-ScheduledTask OpenClawXgkbSync; Start-ScheduledTask OpenClawXgkbSync

升级日志:  logs/auto-upgrade.log
服务日志:  logs/service.log
```

---

## 8. 相关文档

- [INSTALL_AND_UPDATE.md](./INSTALL_AND_UPDATE.md) — 安装与更新详解
- [deploy/README.md](../deploy/README.md) — 安装脚本说明
- [central-manager-node-identity-and-auto-upgrade.md](./central-manager-node-identity-and-auto-upgrade.md) — nodeId 与自动升级
- [RELEASE_TAG.md](./RELEASE_TAG.md) — 发版打 tag

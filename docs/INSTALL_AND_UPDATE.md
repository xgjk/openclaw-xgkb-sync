# openclaw-xgkb-sync 安装与更新指南

仓库地址：<https://github.com/xgjk/openclaw-xgkb-sync>

本文面向**首次安装**与**已有环境升级**，按步骤操作即可。配置细节见 [README.md](../README.md)、[config.example.json](../config.example.json)。

---

## 一、环境要求

| 项目 | 要求 |
|------|------|
| Node.js | **>= 18**（`node -v` 检查）；Docker 部署由镜像提供 Node 24 |
| npm | 随 Node 自带 |
| Git | 用于克隆与更新 |
| Docker（可选） | Docker Compose v2，用于容器化部署 |
| 网络 | 能访问知识库 Open API 地址 |

---

## 私有仓库认证（必看）

若仓库已改为 private，`git clone` / `git pull` / 自动升级脚本里的 `git fetch` 都需要先通过 GitHub 认证。

### 推荐方案 A：SSH + Deploy Key（服务器最稳）

1. 在部署机生成 SSH key（建议专用）：
   ```bash
   ssh-keygen -t ed25519 -C "openclaw-upgrade"
   ```
2. 复制公钥内容（`~/.ssh/id_ed25519.pub`），到 GitHub 仓库：
   - `Settings` → `Deploy keys` → `Add deploy key`
   - 勾选 **Read access**（只读即可）
3. 将仓库远端改为 SSH：
   ```bash
   git remote set-url origin git@github.com:xgjk/openclaw-xgkb-sync.git
   ```
4. 验证：
   ```bash
   git fetch --tags origin
   ```

### 方案 B：HTTPS + Personal Access Token（PAT）

1. 在 GitHub 生成 Fine-grained PAT（仓库权限至少 `Contents: Read-only`）。
2. 执行 `git pull` 时：
   - Username 输入 GitHub 用户名
   - Password 输入 PAT（不是账号密码）
3. 建议保存凭据（macOS）：
   ```bash
   git config --global credential.helper osxkeychain
   ```

> 自动升级脚本本身无需改动；关键是部署机上的 Git 认证要先打通。

---

## 二、首次安装（约 3 分钟）

安装阶段**无需**填写 AppKey、本地路径或任何 mapping。克隆、安装依赖、启动即可；所有业务配置在 **Web 管理控制台** 中完成。

### 1. 克隆仓库

```bash
# 公共仓库可直接 HTTPS；私有仓库请先完成上面的认证配置
git clone https://github.com/xgjk/openclaw-xgkb-sync.git
# 若使用 SSH，可改为：
# git clone git@github.com:xgjk/openclaw-xgkb-sync.git
cd openclaw-xgkb-sync
```

Windows PowerShell 示例：

```powershell
# 公共仓库可直接 HTTPS；私有仓库请先完成上面的认证配置
git clone https://github.com/xgjk/openclaw-xgkb-sync.git
# 若使用 SSH，可改为：
# git clone git@github.com:xgjk/openclaw-xgkb-sync.git
cd openclaw-xgkb-sync
```

### 2. 安装依赖

```bash
npm install
```

### 3. 编译并启动

**生产运行（推荐）：** 完成 Web 配置后，执行平台安装脚本实现**开机自启**（见 [deploy/README.md](../deploy/README.md)）。

```bash
npm run build
npm start
```

**开发调试（改 TS 源码后需重启，无需先 build）：**

```bash
npm run dev
```

指定配置文件路径（可选，默认 `./config.json`）：

```bash
node dist/index.js --config D:\path\to\config.json
```

> **关于 `config.json`**  
> - 首次启动时若不存在，服务会**自动生成**默认 `config.json`（含全局默认值、`mappings: []`，**不含** AppKey）。  
> - **不必**手动 `cp config.example.json config.json`；若你已有自定义 `config.json`，启动时会保留其中已填内容。  
> - 控制台若出现 `请在 Web 控制台补充 AppKey 与同步映射`，表示已进入「零配置安装」模式，属正常现象。

### 4. 验证服务已启动

控制台应出现类似：

- `[OpenClaw Sync] 服务已启动`
- `[ManagementApi] 已启动，监听 http://0.0.0.0:9090`
- `[OpenClaw Sync] mapping 数量: 0（已启用: 0）`（首次安装时 mapping 为空是正常的）

**健康检查：**

```bash
curl http://127.0.0.1:9090/health
```

Windows 若 `curl` 异常，使用：

```powershell
curl.exe http://127.0.0.1:9090/health
```

期望返回 JSON 且 `"ok": true`。

---

## 三、首次配置（Web 管理控制台）

浏览器打开 **<http://127.0.0.1:9090/>**（若 `managementHost` 为 `0.0.0.0`，本机请用 `127.0.0.1`）。

### 1. 全局配置（「全局配置」标签页）

| 步骤 | 操作 |
|------|------|
| 知识库 API 地址 | 默认已填生产环境地址；私有部署时再改 `serverUrl` |
| 全局 AppKey | 填写玄关 Open API 密钥，点击 **「保存配置」** |
| 同步方向 / 间隔等 | 按需调整（默认双向、180 秒自动同步），保存后**立即热重载** |

> AppKey 保存后在页面上以脱敏形式显示；要更换密钥需重新输入完整值再保存。

### 2. 新增同步映射（「同步映射」标签页）

点击 **「新增映射」**，至少填写：

| 字段 | 说明 |
|------|------|
| 映射 ID | 可留空由系统自动生成，或自行指定唯一 ID |
| 本地根目录 | 本地目录**绝对路径**（Agent 工作区） |
| 远端目录路径 | 知识库内路径，如 `宋培众/0518` |
| AppKey | 若未配置全局 AppKey，**本条 mapping 必须填写**独立 AppKey |
| 启用 | 勾选后才会参与同步 |
| **启用映射索引** | 可选。勾选后在 mapping 根目录同步 `.openclaw-sync-map.json`（路径→fileId 全量表）。Push 端发布、Pull 端拉取，详见 [README 映射索引一节](../README.md#映射索引文件-enablefileindex) 与 [sync-logic-reference §11](./sync-logic-reference-for-obsidian.md#11-映射索引文件-enablefileindex) |
| **启用本地文件监听** | push/bidirectional 默认开启。本地保存 md 后约数秒内触发同步；`autoSyncIntervalSec` 仍为定时兜底。索引文件已被监听排除 |

保存 mapping 后配置会写入 `config.json` 并**自动热重载**（含重启 chokidar），一般无需重启进程。

**典型分工**：

| 节点 | `syncDirection` | `enableFileIndex` | `watchEnabled` |
|------|-----------------|-------------------|----------------|
| OpenClaw 服务器（产出笔记） | `push` | ✅ 开启 | ✅ 默认开启 |
| 用户电脑 / Obsidian 侧 Pull Agent | `pull` | ✅ 开启 | —（pull 不启 watch） |

Push 端同步成功后，KB mapping 根目录会出现 `.openclaw-sync-map.json`；Pull 端 sync 开始前会下载到本地 `{localRoot}/.openclaw-sync-map.json`，供 Obsidian 插件读取。

### 3. 试跑同步

- 在 mapping 卡片上点击 **「同步」**，或工具栏 **「全部同步」**
- 切换到 **「运行状态」** 查看 `lastSuccessAt`、错误信息、统计摘要

### 4. 可选：仍用手动编辑 `config.json`

Web 控制台与管理 API 的修改都会写回 `config.json`。高级用户可直接编辑文件后，在控制台点击 **「重载配置」** 或调用 `POST /reload`。  
模板参考：[config.example.json](../config.example.json)。

---

## 四、已有环境更新

> **维护者发版打 Tag**：见 [RELEASE_TAG.md](./RELEASE_TAG.md)。Windows 一键：`.\scripts\release-tag.ps1 -Version 1.0.6 -Push`

更新代码时**不要覆盖**本地 `config.json` 和 SQLite 状态库（默认 `./openclaw-sync-state.db`），否则会丢失密钥与同步水位。

### 标准更新流程

```bash
# 1. 进入项目目录
cd openclaw-xgkb-sync

# 2. 若服务在运行，先停止（Ctrl+C 或结束对应进程）

# 3. 拉取最新代码
git pull origin main
# 若默认分支为 master，改为：git pull origin master
# 若提示 Username/Password，说明私有仓库认证尚未配置（见本文「私有仓库认证」）

# 4. 安装可能新增的依赖
npm install

# 5. 重新编译
npm run build

# 6. 启动
npm start
```

### 更新后建议检查

| 检查项 | 命令 / 操作 |
|--------|-------------|
| 服务存活 | `curl http://127.0.0.1:9090/health` |
| 配置仍有效 | Web 控制台「同步映射」或 `GET /mappings` |
| 热重载配置（若只改了 config） | 控制台「重载配置」或 `POST /reload` |
| 试跑同步 | 控制台「全部同步」或 `POST /sync` |

> 升级后**首次同步**可能触发一次全量对账（略慢），属正常现象。大目录可在低峰期更新。

### 若 `git pull` 有本地修改冲突

```bash
# 查看状态
git status

# 仅保留本地 config（勿提交密钥）
# 可先备份再拉取
copy config.json config.json.bak          # Windows
cp config.json config.json.bak            # Linux/macOS

git stash push -m "local" -- config.json  # 可选：暂存 config
git pull
git stash pop                             # 若有 stash
```

`config.json` 已在 `.gitignore` 中，一般不会被 `git pull` 覆盖；冲突多出现在你改过仓库内其他文件时。

---

## 五、Windows 一键速查

```powershell
# 首次安装（无需事先编辑 config.json）
git clone https://github.com/xgjk/openclaw-xgkb-sync.git
# 若私有仓库且已配置 SSH，可改为：
# git clone git@github.com:xgjk/openclaw-xgkb-sync.git
cd openclaw-xgkb-sync
npm install
npm run build
npm start
# 浏览器打开 http://127.0.0.1:9090/ → 全局配置填 AppKey → 新增映射 → 同步

# 更新
cd openclaw-xgkb-sync
# 先停止正在运行的 npm run dev / npm start
git pull
npm install
npm run build
npm start
```

---

## 六、开机自启与升级（Linux / macOS / Windows）

推荐在首次 `npm run build` 并完成 Web 控制台基础配置后，执行 **一条** 平台安装命令。完整步骤见 **[docs/DEPLOY_OPS_SOP.md](./DEPLOY_OPS_SOP.md)**（运维上线 SOP）与 [deploy/README.md](../deploy/README.md)。

| 平台 | 一键安装（注册自启 + 启动服务） |
|------|--------------------------------|
| **Linux** | `bash deploy/linux/install.sh` |
| **macOS** | `bash deploy/macos/install.sh` |
| **Windows** | `powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1` |

安装脚本会：`npm install --include=dev` → `build` → 注册 systemd / LaunchAgent / 计划任务 → 健康检查。

### 开机自启机制

| 平台 | 机制 | 说明 |
|------|------|------|
| Linux | **systemd 用户服务** | `~/.config/systemd/user/openclaw-xgkb-sync.service`；`loginctl enable-linger` 支持未登录自启 |
| macOS | **LaunchAgent** | `~/Library/LaunchAgents/com.openclaw.xgkb-sync.plist`；登录后自启，`KeepAlive` 崩溃拉起 |
| Windows | **任务计划程序** | 任务名 `OpenClawXgkbSync`，**用户登录时**启动 |

### 手动升级

```bash
cd openclaw-xgkb-sync
git pull origin main
npm install --include=dev
npm run build
```

然后按平台重启：

```bash
# Linux
systemctl --user restart openclaw-xgkb-sync

# macOS
launchctl kickstart -k gui/$(id -u)/com.openclaw.xgkb-sync

# Windows PowerShell
Stop-ScheduledTask -TaskName OpenClawXgkbSync; Start-ScheduledTask -TaskName OpenClawXgkbSync
```

`config.json` 与 `openclaw-sync-state.db` 不会被 `git pull` 覆盖。

### 自动升级（中心心跳）

在 `config.json` 保持 `autoUpgradeEnabled: true`（默认）时，节点发现新版本且**同步空闲**后，会 detached 执行：

- Linux / macOS：`scripts/auto-upgrade.sh`
- Windows：`scripts/auto-upgrade.ps1`

脚本会识别 **pm2 → systemd（用户/系统）→ launchd → Windows 计划任务**，否则按管理端口停进程并后台拉起。日志：`logs/auto-upgrade.log`。

前提：git clone 安装、私有仓库认证已打通、Nacos `openclaw.sync.latest-version` 已更新。详见 [central-manager-node-identity-and-auto-upgrade.md](./central-manager-node-identity-and-auto-upgrade.md)。

### 可选：PM2（三平台通用）

```bash
npm run build
pm2 start dist/index.js --name openclaw-xgkb-sync -- --config config.json
pm2 save
pm2 startup   # 按提示执行生成的命令
```

自动升级脚本会优先 `pm2 restart openclaw-xgkb-sync`。

### 日志落盘

启动后默认写入 `logs/openclaw-sync-YYYY-MM-DD.log`；安装脚本另将服务 stdout 写入 `logs/service.log`（或 macOS `~/Library/Logs/`）。

```bash
node dist/index.js --config config.json --log-file ./logs/my-test.log
node dist/index.js --no-log-file   # 仅控制台
```

---

## 七、Docker 部署（可选）

若暂不使用 Docker，可跳过本节。需要容器化时见 `docker-compose.yml` 与下文简要说明。

| 形态 | 开机自启 | 推荐升级方式 | 自动升级 |
|------|----------|--------------|----------|
| **Docker Compose** | `restart: unless-stopped` + Docker 开机自启 | `git pull` + `docker compose up -d --build` | `scripts/auto-upgrade.docker.sh` |

### Docker Compose 部署

适用于将 sync 服务与 OpenClaw 同机或独立服务器容器化。仓库根目录已提供 `docker-compose.yml` 与 `Dockerfile`。

#### 1. 前提

- 已安装 [Docker](https://docs.docker.com/get-docker/) 与 Docker Compose v2
- 宿主机已 `git clone` 本仓库（私有仓库先完成本文 **「私有仓库认证」**）
- **同步目录必须挂载进容器**：mapping 的 `localRoot` 填**容器内路径**，不能填仅存在于宿主机的路径

#### 2. 首次启动

```bash
cd openclaw-xgkb-sync
docker compose up -d --build
docker compose logs -f   # 等待出现 ManagementApi 监听 9090
curl http://127.0.0.1:9090/health
```

浏览器打开 `http://127.0.0.1:9090/`，在 Web 控制台配置 AppKey 与 mapping（与裸机安装相同）。

#### 3. 挂载工作区示例

编辑 `docker-compose.yml`，取消注释并改成你的宿主机路径：

```yaml
volumes:
  - .:/app
  - openclaw_sync_node_modules:/app/node_modules
  - /home/user/.openclaw/workspace:/workspace:rw   # Linux / macOS 示例
  # Windows Docker Desktop 示例：
  # - C:/Users/you/.openclaw/workspace:/workspace:rw
```

mapping 中 `localRoot` 示例：`/workspace/project/202606/xxx`（容器内路径）。

若 OpenClaw 在宿主机、sync 在容器，Channel 插件 upsert 的绝对路径须与容器挂载一致。

#### 4. Docker 内 nodeId

容器内自动探测 IP 常失败或选到 docker 网桥。请在 `config.json` 配置宿主机内网 IP：

```json
{
  "nodeAdvertiseIp": "192.168.1.100",
  "managementPort": 9090
}
```

#### 5. 开机自启

| 层级 | 做法 |
|------|------|
| 容器 | `docker-compose.yml` 已设 `restart: unless-stopped` |
| Docker 引擎 | Linux：启用 `docker.service`；macOS/Windows：Docker Desktop → Settings → 勾选开机启动 |
| 可选（Linux 宿主机） | 用 systemd 在开机时 `docker compose up -d`（工作目录为项目根） |

**Linux systemd 示例**（在宿主机创建 `/etc/systemd/system/openclaw-xgkb-sync.service`）：

```ini
[Unit]
Description=openclaw-xgkb-sync (Docker Compose)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/openclaw-xgkb-sync
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-xgkb-sync
```

#### 6. 升级

**手动（推荐验证）：**

```bash
cd openclaw-xgkb-sync
# 若容器在运行可先 down，也可直接 up --build（会重建并滚动重启）
git pull origin main
docker compose up -d --build
curl http://127.0.0.1:9090/health
```

`config.json`、SQLite、`logs/` 在挂载的宿主机目录，**不会被覆盖**。

**自动（接入中心心跳且 `autoUpgradeEnabled: true`）：**

- Compose 已注入 `OPENCLAW_DEPLOYMENT=docker`，进程会自动选用 `scripts/auto-upgrade.docker.sh`
- 脚本在容器内：`git fetch/checkout` → `npm install` → `npm run build` → 结束监听进程 → Docker `restart` 策略拉起新进程
- 也可显式配置：`"autoUpgradeScript": "./scripts/auto-upgrade.docker.sh"`
- 日志：`logs/auto-upgrade.log`

#### 7. Docker 卷与文件监听

- 同步目录在 **bind mount** 上时，若 watch 漏事件，可在 mapping 或全局设 `watchUsePolling: true`（见 README）
- 匿名卷 `openclaw_sync_node_modules` 避免宿主机空 `node_modules` 覆盖容器依赖

#### 8. 常用命令

```bash
docker compose ps
docker compose logs -f openclaw-xgkb-sync
docker compose restart openclaw-xgkb-sync
docker compose down
```

---

## 八、常见问题

| 现象 | 处理 |
|------|------|
| `node -v` 低于 18 | 安装 Node 18+ LTS |
| 启动报 `no such column: local_ino` | 使用最新代码并重启；旧库会自动迁移列 |
| `mapping 数量: 0` | **首次安装正常**；在 Web 控制台「新增映射」 |
| 同步失败 / AppKey | 在「全局配置」或 mapping 中填写有效 AppKey 并保存 |
| `POST /mappings` 报 AppKey 必填 | 全局与各 mapping 均无 AppKey 时无法创建 mapping；至少填一处 |
| 更新后行为异常 | 查看 `logs/` 下 `[KbApi] request#` 日志；必要时点击「重载配置」 |
| 端口 9090 被占用 | 在「全局配置」改 `managementPort` 后**重启进程**（该字段需重启才生效） |
| Docker 内 nodeId 启动失败 | 在 `config.json` 配置 `nodeAdvertiseIp` 为宿主机内网 IP |
| Docker 升级后仍是旧版本 | 确认宿主机 `git pull` 成功，再执行 `docker compose up -d --build` |
| Docker 同步目录无文件 | 检查 `localRoot` 是否为**容器内**路径，且 compose 已挂载宿主机工作区 |
| Docker 启动 `tsc: not found` | `NODE_ENV=production` 导致未装 devDependencies；使用 1.1.7+ 入口脚本，或执行 `docker compose down` 后删掉 `openclaw_sync_node_modules` 卷再 `up --build` |
| 改了 `config.json` 未生效 | 控制台「重载配置」或 `POST /reload`（`managementPort` / `managementHost` 除外，需重启） |
| Pull 端无 `.openclaw-sync-map.json` | Push 端是否开启 `enableFileIndex` 且 sync 成功；Pull 端是否开启且方向为 `pull`/`bidirectional` |
| 索引 publish 失败 | 日志搜 `[FileIndex]`；主 sync 成功不影响水位，下轮 hash 未更新会自动重试 |

更多排错见 [README.md § 常见问题](../README.md)。

---

## 九、相关文档

- [README.md](../README.md) — 功能说明与配置参考（含 [映射索引](#映射索引文件-enablefileindex)）
- [sync-logic-reference-for-obsidian.md](./sync-logic-reference-for-obsidian.md) — Obsidian 插件对照；§11 映射索引消费约定
- [MANAGEMENT_API.md](./MANAGEMENT_API.md) — HTTP API（脚本/自动化）
- [DEPLOY_OPS_SOP.md](./DEPLOY_OPS_SOP.md) — **运维节点上线 SOP**（开机自启、验收、升级）
- [deploy/README.md](../deploy/README.md) — 各平台一键安装脚本
- [config.example.json](../config.example.json) — 配置字段说明（模板，安装时可不复制）
- [temp/方案一-映射文件独立同步-评估与执行计划.md](./temp/方案一-映射文件独立同步-评估与执行计划.md) — 索引方案设计与选型对比

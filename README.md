# openclaw-xgkb-sync

OpenClaw 节点与玄关知识库（XGKB）文件双向同步 Agent。

不依赖 Obsidian 客户端，直接作为 Node.js 后台服务运行，支持多台 OpenClaw 节点并行同步到同一知识库空间。

> 架构设计、同步流程与可靠性说明详见 [DESIGN.md](./DESIGN.md)。

---

## 功能特性

- **增量优先**：`listChanges` 拉取变更，仅处理有差异的文件；全量兜底保证一致性
- **双向同步**：LWW 策略，支持 `bidirectional / push / pull` 三种方向
- **多 Mapping**：单节点可配置多条本地目录 ↔ 云端目录映射，每条独立配置方向与文件过滤
- **按用户限速**：每个 `appKey` 独享令牌桶，多用户场景互不干扰
- **HTTP 管理 API**：内置轻量 HTTP 服务，支持远程查看状态、触发同步、热重载配置
- **SQLite 状态库**：持久化同步水位与文件状态，无需外部依赖

---

## 快速开始

### 1. 安装依赖

```bash
cd openclaw-xgkb-sync
npm install
```

### 2. 配置

```bash
cp config.example.json config.json
# 按实际情况修改 config.json
```

### 3. 构建

```bash
npm run build
```

### 4. 运行

```bash
# 使用默认 config.json
npm start

# 指定配置文件
node dist/index.js --config /path/to/my-config.json

# 同时将日志落盘
node dist/index.js --config config.json --log-file /var/log/openclaw-xgkb-sync.log

# 也可通过环境变量指定日志文件
export OPENCLAW_SYNC_LOG_FILE=/var/log/openclaw-xgkb-sync.log
npm start

# 开发模式（无需先 build）
npm run dev
```

---

## 配置参考

### 全局字段

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `serverUrl` | 是 | — | 知识库 Open API 地址，如 `https://your-server/open-api/` |
| `appKey` | 是 | — | 全局 API 鉴权密钥，单条 mapping 未单独配置时使用此值 |
| `syncDirection` | 否 | `bidirectional` | 全局同步方向：`bidirectional` / `push`（仅上传）/ `pull`（仅下载） |
| `autoSyncIntervalSec` | 否 | `60` | 自动同步间隔（秒），`0` = 关闭定时同步 |
| `stateDbPath` | 否 | `./openclaw-sync-state.db` | SQLite 状态库路径 |
| `maxConcurrentMappings` | 否 | `2` | 最大并发 mapping 数。多 mapping 场景建议调高，参考：[多实例与大规模部署](#多实例与大规模部署) |
| `maxRequestsPerMinute` | 否 | `60` | 每 appKey 每分钟最大请求数（令牌桶稳态速率）。每个 `appKey` 独立计算，互不干扰 |
| `rateLimitBurst` | 否 | `8` | 令牌桶突发容量，允许短时间内连续发出最多 N 个请求后再按稳态补充 |
| `rateLimitCooldownSec` | 否 | `60` | 收到限流响应（HTTP 429 或 resultCode 610012）后的冷却时间（秒） |
| `downloadConcurrency` | 否 | `5` | 单次同步中并发下载文件数 |
| `uploadConcurrency` | 否 | `3` | 单次同步中并发上传文件数 |
| `startupJitterMaxSec` | 否 | `20` | 启动后首次同步的随机抖动上限（秒）。多实例同时重启时分散请求，设为 `0` 禁用 |
| `managementPort` | 否 | `9090` | HTTP 管理 API 监听端口，设为 `0` 禁用管理 API |
| `managementHost` | 否 | `127.0.0.1` | HTTP 管理 API 监听地址。仅本机访问时保持默认；需跨机器访问时改为 `0.0.0.0`（注意配置防火墙） |

### 每条 Mapping 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `mappingId` | 是 | 唯一标识，同一节点内不可重复 |
| `localRoot` | 是 | 本地绝对目录路径 |
| `enabled` | 否 | 是否启用此映射，默认 `true` |
| `appKey` | 否 | 该 mapping 独立使用的 API 密钥，填写后**优先于全局 `appKey`**。多用户场景下每个 mapping 使用不同 appKey，限速器按 appKey 独立计算，互不影响 |
| `projectId` | 否 | 知识库空间 ID。不填则自动调用 `getPersonalProjectId` 获取个人空间 |
| `remoteRootFileId` | 否 | 远端根目录 fileId。填写时零额外 API 调用，启动最快 |
| `remoteRootFolderPath` | 否 | 远端根目录路径，如 `"OpenClaw/OutputA"`。**路径在远端不存在时会自动逐级创建**；不填表示同步 projectId 空间根目录 |
| `filePatterns` | 否 | 匹配文件的 glob 模式，默认 `["**/*.md"]` |
| `excludePatterns` | 否 | 排除文件的 glob 模式，默认 `["**/_conflict_*", "**/.tmp/**"]` |
| `syncDirection` | 否 | 单条 mapping 的同步方向，覆盖全局配置 |

### `remoteRootFileId` 与 `remoteRootFolderPath` 组合

| `remoteRootFileId` | `remoteRootFolderPath` | 行为 |
|---|---|---|
| 不填 | 不填 | 同步 `projectId` 空间**根目录**下所有匹配文件 |
| 不填 | 填路径 | 启动时自动解析路径 → fileId，路径不存在则自动创建；解析结果缓存到 SQLite |
| 填写 | 不填 | 使用指定 fileId，启动时通过 `batchGetMeta` 反向解析路径 |
| 填写 | 填路径 | 最优配置，零额外 API 调用 |

### 配置示例

```json
{
  "serverUrl": "https://your-server/open-api/",
  "appKey": "global-app-key",
  "syncDirection": "bidirectional",
  "autoSyncIntervalSec": 120,
  "maxConcurrentMappings": 5,
  "managementPort": 9090,
  "managementHost": "0.0.0.0",
  "mappings": [
    {
      "mappingId": "user-alice",
      "enabled": true,
      "localRoot": "/sandboxes/alice/workspace",
      "appKey": "alice-personal-app-key",
      "remoteRootFolderPath": "AgentOutput/Alice",
      "syncDirection": "push",
      "filePatterns": ["**/*.md"]
    }
  ]
}
```

---

## HTTP 管理 API

服务启动后，内置 HTTP 管理接口可供运维使用，无需 SSH 进服务器。

### 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 存活探针，返回版本、PID、uptime、mapping 数量 |
| `GET` | `/status` | 详细状态：所有 mapping 的同步时间、是否正在同步、上次错误 |
| `GET` | `/mappings` | 列出所有 mapping 配置摘要（appKey 字段不回显） |
| `POST` | `/mappings` | 新增一条 mapping，**自动写入 config.json 并热重载** |
| `PUT` | `/mappings/:mappingId` | 更新指定 mapping，自动写入并热重载 |
| `DELETE` | `/mappings/:mappingId` | 删除指定 mapping，自动写入并热重载 |
| `POST` | `/sync` | 立即触发**所有** mapping 同步 |
| `POST` | `/sync/:mappingId` | 立即触发**指定** mapping 同步 |
| `POST` | `/reload` | 手动热重载 `config.json` |

### 常用命令

```bash
# 查看服务健康状态和版本
curl http://10.0.0.5:9090/health

# 列出所有 mapping
curl http://10.0.0.5:9090/mappings

# 新增一条 mapping（写入 config.json 并立即生效）
curl -X POST http://10.0.0.5:9090/mappings \
  -H "Content-Type: application/json" \
  -d '{
    "mappingId": "user-bob",
    "localRoot": "/sandboxes/bob/workspace",
    "appKey": "bob-personal-app-key",
    "remoteRootFolderPath": "AgentOutput/Bob",
    "syncDirection": "push",
    "filePatterns": ["**/*.md"]
  }'

# 修改 mapping 配置（部分更新，只传要改的字段，其余字段保持原值）

# 仅禁用（不影响其他字段）
curl -X PUT http://10.0.0.5:9090/mappings/user-bob \
  -H "Content-Type: application/json" \
  -d '{ "enabled": false }'

# 仅修改同步方向
curl -X PUT http://10.0.0.5:9090/mappings/user-bob \
  -H "Content-Type: application/json" \
  -d '{ "syncDirection": "push" }'

# 清空 remoteRootFolderPath（传空字符串即可，其他字段不受影响）
curl -X PUT http://10.0.0.5:9090/mappings/user-bob \
  -H "Content-Type: application/json" \
  -d '{ "remoteRootFolderPath": "" }'

# 删除一条 mapping
curl -X DELETE http://10.0.0.5:9090/mappings/user-bob

# 手动触发某个 mapping 立即同步
curl -X POST http://10.0.0.5:9090/sync/user-alice

# 触发所有 mapping 立即同步
curl -X POST http://10.0.0.5:9090/sync
```

### `/health` 返回示例

```json
{
  "ok": true,
  "version": "1.0.0",
  "pid": 12345,
  "uptime": 3600,
  "startedAt": "2026-05-11T06:05:00.000Z",
  "mappingCount": 3,
  "enabledMappingCount": 2,
  "nodeVersion": "v20.11.0"
}
```

### 热重载说明

调用 `/reload` 时，服务内部执行：

1. 重新读取磁盘上的 `config.json`
2. 停止当前调度器（清理定时器，不影响正在进行中的同步）
3. 用新配置启动新调度器
4. HTTP 管理服务全程不停机，对调用方透明

> **注意**：`managementPort` 和 `managementHost` 在热重载中**不会**生效，这两个字段需要重启进程才能变更。

---

## 生产部署建议

程序仅向 **stdout/stderr** 打日志，不配置时不会自动生成日志文件。

**日志收集方式（四选一）：**

1. **systemd + journald（推荐 Linux）**
   `journalctl -u openclaw-xgkb-sync -f`，无需改命令行。

2. **launchd + 标准输出文件（推荐 macOS）**
   使用 `StandardOutPath` / `StandardErrorPath`，或使用下文「macOS 部署」中的 `--log-file` 与 plist 示例。

3. **本进程双写**
   设置 `OPENCLAW_SYNC_LOG_FILE` 环境变量或 `--log-file` 参数，控制台与文件同时输出。

4. **Shell 重定向**
   `node dist/index.js >> /var/log/app.log 2>&1`（路径按系统调整，macOS 可写到 `~/Library/Logs/`）

**systemd 服务示例：**

```ini
[Unit]
Description=OpenClaw XGKB Sync Agent
After=network.target

[Service]
WorkingDirectory=/opt/openclaw-xgkb-sync
ExecStart=/usr/bin/node dist/index.js --config /opt/openclaw-xgkb-sync/config.json
Environment=OPENCLAW_SYNC_LOG_FILE=/var/log/openclaw-xgkb-sync.log
Restart=on-failure
RestartSec=10
User=openclaw

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-xgkb-sync
journalctl -u openclaw-xgkb-sync -f
```

### macOS 部署

与 Linux 相同，本项目为纯 Node.js 进程，**无需 Xcode 或原生编译 SQLite**。在 Mac 上按下面步骤即可常驻运行。

#### 1. 安装 Node.js

任选其一（建议 LTS，且满足 `>= 18`）：

- [Node.js 官网](https://nodejs.org/) 安装包
- [Homebrew](https://brew.sh/)：`brew install node`
- [nvm](https://github.com/nvm-sh/nvm)：`nvm install 20 && nvm use 20`

在终端执行 `node -v` 确认版本。

#### 2. 安装依赖、构建与本地运行

```bash
cd /path/to/openclaw-xgkb-sync
npm install
cp config.example.json config.json
# 编辑 config.json：mappings[].localRoot 请使用绝对路径，例如 /Users/你的用户名/workspace
npm run build
npm start
# 或指定配置
node dist/index.js --config /path/to/config.json
```

日志可选：`--log-file "$HOME/Library/Logs/openclaw-xgkb-sync.log"` 或环境变量 `OPENCLAW_SYNC_LOG_FILE`（与 Linux 说明一致）。

#### 3. 登录时自动启动（launchd，推荐）

使用用户级 LaunchAgent，无需 root。先确认本机 Node 路径（Apple Silicon 常见为 `/opt/homebrew/bin/node`，Intel 常见为 `/usr/local/bin/node`）：

```bash
which node
```

在 `~/Library/LaunchAgents/com.openclaw.xgkb-sync.plist` 写入（请把 `YOUR_USER`、`项目目录`、`node 路径` 改成你的实际值）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openclaw.xgkb-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOUR_USER/path/to/openclaw-xgkb-sync/dist/index.js</string>
    <string>--config</string>
    <string>/Users/YOUR_USER/path/to/openclaw-xgkb-sync/config.json</string>
    <string>--log-file</string>
    <string>/Users/YOUR_USER/Library/Logs/openclaw-xgkb-sync.log</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USER/path/to/openclaw-xgkb-sync</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USER/Library/Logs/openclaw-xgkb-sync.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USER/Library/Logs/openclaw-xgkb-sync.stderr.log</string>
</dict>
</plist>
```

加载与查看状态：

```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.xgkb-sync.plist
# 修改 plist 后需 unload 再 load
launchctl unload ~/Library/LaunchAgents/com.openclaw.xgkb-sync.plist
launchctl load ~/Library/LaunchAgents/com.openclaw.xgkb-sync.plist
```

取消开机自启：`launchctl unload ~/Library/LaunchAgents/com.openclaw.xgkb-sync.plist` 后删除该 plist 即可。

#### 4. 管理 API 与防火墙

默认 `managementHost` 为 `127.0.0.1` 时，本机调试：

```bash
curl http://127.0.0.1:9090/health
```

若将 `managementHost` 改为 `0.0.0.0` 供局域网访问，请在 **系统设置 → 网络 → 防火墙** 中按需放行对应端口，或仅保留本机访问以降低暴露面。

> `config.json` 含密钥，勿提交仓库；生产路径与文件权限按安全规范收紧。

---

## 多实例与大规模部署

### 多台服务器同步同一知识库

- **共用 appKey 时**：三台服务器共享同一 appKey 的限流额度，建议将 `maxRequestsPerMinute` 设为 `总限额 ÷ 实例数`（如限额 120，三台各配 `40`）
- **各用独立 appKey 时**：每台均可配满 `maxRequestsPerMinute`，互不干扰
- 保持 `startupJitterMaxSec` 默认值（20s），分散多实例同时重启时的请求突刺

### 数百个 Mapping 场景

适用于云端部署多个个人助理 Agent、每个 Agent 对应一位用户知识库的场景：

- 每个 mapping 配置独立 `appKey`（用户各自的密钥），限速器按 appKey 独立管理
- 调高 `maxConcurrentMappings`（建议 10～20），提升并发吞吐
- 增量模式下若本地和远端均无变化，决策阶段会被完全跳过，单轮同步仅需几毫秒
- `autoSyncIntervalSec` 建议设为 `120` 或以上，给每轮完整扫描留足时间

---

## 环境要求

- Node.js >= 18（使用内置 `fetch`）
- SQLite 通过 `node-sqlite3-wasm`（WebAssembly）提供，**无需 Visual Studio 或 native 编译工具**

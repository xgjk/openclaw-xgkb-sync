# 架构设计文档

> 本文档面向开发者和维护人员，描述 openclaw-xgkb-sync 的内部架构、同步流程与设计决策。
> 使用说明详见 [README.md](./README.md)。

---

## 模块结构

```
src/
├── index.ts          入口：解析参数、加载配置、启动调度器与管理 API
├── consoleTee.ts     可选：将 console 双写到日志文件（OPENCLAW_SYNC_LOG_FILE / --log-file）
├── config.ts         配置加载与校验（loadConfig / validateConfig）
├── types.ts          TypeScript 类型定义（SyncConfig、SyncMapping、FileState 等）
├── constants.ts      API 路径、默认常量、工具函数
├── rateLimiter.ts    令牌桶限速器（含 429 / 业务限流码冷却）
├── kbApi.ts          知识库 HTTP 客户端（Node.js fetch，含重试与限速）
├── pathSanitize.ts   路径安全处理工具
├── localFs.ts        本地文件系统适配器（Node.js fs/promises）
├── remoteFs.ts       远端知识库文件适配器（listFiles、createFile、deleteFile 等）
├── syncStateDb.ts    SQLite 状态库（node-sqlite3-wasm，WAL 模式）
├── syncEngine.ts     核心同步决策与执行引擎
├── scheduler.ts                  多 mapping 调度器（防重入、按 appKey 限速、并发控制）
├── managementApi.ts              HTTP 管理 API（health / status / mappings CRUD / sync / reload）
└── managementApiCredentials.ts   管理 API：有效 appKey 推导与保存前校验（与 docs/MANAGEMENT_API.md 一致）
```

---

## 一轮同步流程

```
Scheduler.doSync(mapping)
  │
  ├─ 1. 读取 SQLite 缓存（projectId / rootFileId / lastSyncSince）
  │
  ├─ 2. RemoteFsAdapter.init()
  │      ├─ projectId：配置 > 缓存 > getPersonalProjectId() API
  │      ├─ rootFileId：配置 > 缓存 > resolveFileIdFromPath()
  │      │    └─ 路径各段不存在时自动 createFolder() 逐级创建
  │      └─ 解析结果写回 SQLite 缓存
  │
  ├─ 3. SyncEngine.runSync()
  │      │
  │      ├─ 本地扫描：LocalFsAdapter.listFiles()（micromatch 过滤）
  │      │
  │      ├─ 远端视图构建（buildRemoteMap）
  │      │    ├─ [有水位] 增量路径：listChanges(safeSince) → batchGetMeta → 路径重建
  │      │    │    ├─ 路径重建失败（全新目录）→ 降级全量
  │      │    │    └─ 成功 → remoteDeltaCount = upsert数 + delete数
  │      │    └─ [无水位 / 降级] 全量路径：listDescendantFiles 分页扫描
  │      │
  │      ├─ 批量加载 SQLite 文件状态（getAllFileStates，O(1) 内存查找）
  │      │
  │      ├─ 增量快速通道（remoteDeltaCount === 0）
  │      │    └─ 本地无新增/修改/删除 → 跳过决策循环，直接返回全 skip
  │      │
  │      ├─ 决策阶段：路径并集 × decide(local, remote, record) → SyncOp
  │      │
  │      └─ 执行阶段
  │           ├─ 删除操作串行（避免竞态）
  │           ├─ 下载队列（downloadConcurrency 并发，批间 pause）
  │           └─ 上传队列（uploadConcurrency 并发，批间 pause）
  │
  └─ 4. 更新 SQLite 水位（仅无系统性失败时推进 lastSyncSince）
```

---

## 决策策略（LWW）

`decide(local, remote, record)` 根据本地、远端、历史记录三态决策操作：

| 场景 | 条件 | 决策 |
|------|------|------|
| 首次出现，仅本地有 | `!record && local && !remote` | `upload-new`（push/bidirectional）/ `skip`（pull） |
| 首次出现，仅远端有 | `!record && !local && remote` | `download-new`（pull/bidirectional）/ `skip`（push） |
| 首次出现，双端均有 | `!record && local && remote` | mtime 较大者胜；push → 上传；pull → 下载 |
| 本地缺失，远端有新改动 | `!local && remote.mtime > record.remoteMtime` | `download-update`（回补） |
| 本地缺失，远端未变 | `!local && remote.mtime ≤ record.remoteMtime` | `delete-remote` |
| 远端缺失，本地有新改动 | `local && !remote && local.mtime > record.localMtime` | `upload-new`（重新上传） |
| 远端缺失，本地未变 | `local && !remote && local.mtime ≤ record.localMtime` | `delete-local` |
| 仅本地改动 | `localChanged && !remoteChanged` | `upload-update` |
| 仅远端改动 | `!localChanged && remoteChanged` | `download-update` |
| 双端均改动（冲突） | `localChanged && remoteChanged` | mtime 较大者胜（LWW） |
| 双端均未变 | `!localChanged && !remoteChanged` | `skip` |

> `syncDirection` 为 `push` 时跳过所有下载操作；`pull` 时跳过所有上传操作。

---

## 限速器设计

### 按 appKey 独立限速

每个 appKey 对应知识库服务端的一个独立限流配额。Scheduler 维护 `Map<appKey, RateLimiter>`，同一 appKey 的所有请求共享一个令牌桶，不同 appKey 互不干扰。

```
appKey-A ──→ RateLimiter-A (60 req/min)
appKey-B ──→ RateLimiter-B (60 req/min)
appKey-C ──→ RateLimiter-C (60 req/min)
```

在数百个 mapping 各用独立 appKey 的场景下，每个用户均可独享配置的速率上限，不会因他人占用而降速。

### 令牌桶参数

| 参数 | 说明 |
|------|------|
| `maxRequestsPerMinute` | 稳态补充速率（令牌/分钟） |
| `rateLimitBurst` | 桶容量（初始令牌数，允许短时突发） |
| `rateLimitCooldownSec` | 收到 429 后整体暂停时长 |

### 限流处理路径

```
HTTP 429 / resultCode 610012
  → limiter.onRateLimited(retryAfterMs?)
  → 设置 pauseUntil = now + cooldownMs
  → 令牌清零（防冷却结束后立即再突发）
  → 后续所有 acquire() 调用等待至 pauseUntil
```

---

## 性能设计

### 增量同步快速通道

增量模式下，`tryIncrementalRemoteMap` 返回 `remoteDeltaCount`（本轮远端实际变更数）。

当 `remoteDeltaCount === 0` 时，`runSync` 在决策前先做三项内存检查：
- 本地是否有新增文件（不在 recordMap 中）
- 本地是否有修改（mtime > record.localMtime）
- 本地是否有删除（recordMap 中有但 localMap 中无）

全部为否时直接返回，跳过 O(n) 的决策循环。在无变化的常见场景下，单轮同步从数百毫秒降至几毫秒。

### 批量加载文件状态

决策循环不再对每个文件单独调用 `db.getFileState()`，而是在循环前调用 `db.getAllFileStates()` 一次性加载全部记录到内存 Map，循环内 O(1) 查找。

| 方案 | 5000 文件的 DB 操作 |
|------|---------------------|
| 原方案：逐条查询 | 5000 次独立 SQLite 查询（≈300-600ms） |
| 现方案：批量加载 | 1 次批量查询（≈10-30ms） |

### 调度并发控制

```
triggerAll()
  ├─ 前 maxConcurrentMappings 个：立即 scheduleMapping()
  └─ 其余：按顺序 setTimeout(n × 500ms) 错开

scheduleMapping()
  └─ 若 isSyncing=true → pendingSync=true（不重复入队）
     若 isSyncing=false → 立即执行
```

---

## 可靠性设计

| 机制 | 说明 |
|------|------|
| **水位保守提交** | 本轮有任何文件失败 → 不推进 `lastSyncSince`，下轮重新对账失败文件 |
| **安全回拨窗口** | `safeSince = lastSyncSince - 5000ms`，防时钟偏差漏事件 |
| **全量兜底** | 增量路径失败（listChanges 报错 / 路径无法重建）→ 自动降级全量扫描 |
| **单文件隔离** | 每个文件独立 try/catch，单文件失败不影响本轮其他文件 |
| **防重入锁** | 同一 mappingId 同时最多一个同步协程，新触发合并为 pending |
| **指数退避** | 5xx 网络错误重试，退避 1s/2s，最多 3 次 |
| **永久错误不重试** | 4xx 业务错误（权限不足、参数错误等）直接记录失败，不重试 |
| **进程级异常兜底** | `uncaughtException` / `unhandledRejection` 只记录日志不崩溃 |

---

## remoteRootFolderPath 自动创建

`RemoteFsAdapter.init()` 调用 `resolveFileIdFromPath()` 按路径段逐级解析远端目录。若某一层不存在，调用 `api.createFolder()` 自动创建，而非返回错误。

```
resolveFileIdFromPath("OpenClaw/OutputA/2026")
  ├─ getLevel1Folders() → 找 "OpenClaw"
  │    └─ 不存在 → createFolder(parentId="0", name="OpenClaw") → id=100
  ├─ getChildFiles(100) → 找 "OutputA"
  │    └─ 不存在 → createFolder(parentId="100", name="OutputA") → id=200
  └─ getChildFiles(200) → 找 "2026"
       └─ 不存在 → createFolder(parentId="200", name="2026") → id=300
  → 返回 "300"
```

---

## HTTP 管理 API 内部设计

`ManagementApi` 使用 Node.js 内置 `http` 模块，无额外依赖。**HTTP 路由的请求/响应契约、错误码与 AI 调用说明**以 [docs/MANAGEMENT_API.md](./docs/MANAGEMENT_API.md) 为准；本节仅保留路由表与实现要点。

路由表（method + path 精确匹配，无正则路由框架）：

```
GET    /health              → handleHealth()         读 scheduler.getConfig()
GET    /status              → handleStatus()         读 scheduler.getStatus() + getConfig()
GET    /mappings            → handleListMappings()   列出所有 mapping 摘要（appKey 不回显）
POST   /mappings            → handleCreateMapping()  新增 mapping，写 config.json + reload（请求体可省略 mappingId，自动生成；见下）
PUT    /mappings/:id        → handleUpdateMapping()  部分合并更新，写 config.json + reload
DELETE /mappings/:id        → handleDeleteMapping()  删除 mapping，写 config.json + reload
POST   /sync                → handleSyncAll()        遍历 enabled mappings 逐个 triggerMapping()
POST   /sync/:mappingId     → handleSyncOne()        triggerMapping(mappingId)
POST   /reload              → handleReload()         调用 onReload() 回调
```

**`POST /mappings`：** 请求体可为合法 JSON 对象；`mappingId` 可省略或空白，服务端在写入前生成唯一 id。合并后仍经 `validateMapping()` 校验。保存前另经「有效 API 密钥」校验：根级全局 `appKey` 为空时，本条必须带非空 `appKey`，否则 `400` 且 `errorCode=MAPPING_APPKEY_REQUIRED_WHEN_NO_GLOBAL_APPKEY`（详见 [docs/MANAGEMENT_API.md](./docs/MANAGEMENT_API.md)）。

**`PUT /mappings/:id` 合并规则：**

- 以现有 mapping 记录为基础，将请求体中的字段逐一覆盖（`{ ...existing, ...body }`）
- 请求体中**不包含**的字段 → 保留原值（例如只传 `enabled` 不会清空 `localRoot` 等字段）
- 请求体中包含且值为空字符串的可选路径字段（`remoteRootFolderPath`、`remoteRootFileId`）→ 视为清空该字段
- 合并后的对象仍需通过 `validateMapping()` 校验，必填字段（`mappingId`、`localRoot`）由原值兜底

`onReload` 回调在 `index.ts` 中实现：

```typescript
function doReload(): ReloadResult {
  const newConfig = loadConfig(absConfigPath);   // 重新读取磁盘配置
  schedulerRef.current.stop();                    // 停止旧调度器（清理 timers）
  schedulerRef.current = new SyncScheduler(newConfig);
  schedulerRef.current.start();
  return { ok: true, config: newConfig };
}
```

HTTP 服务器实例在整个进程生命周期内保持不变，reload 只替换 `schedulerRef.current`，对外连接无感知。

---

## 部署与硬件参考

瓶颈通常在**知识库 API 限流**和**网络延迟**，而非单机算力。

| 场景 | CPU | 内存 | 磁盘 |
|------|-----|------|------|
| 单机、低频、少 mapping | 2 vCPU | 4 GB | ≥ 20 GB SSD |
| 多 mapping、对延迟敏感 | 4 vCPU | 8 GB | ≥ 50 GB SSD（NVMe 更佳） |
| 数百 mapping（多用户） | 4 vCPU | 8 GB | ≥ 50 GB SSD |

- `localRoot` 和 `stateDbPath` 建议放在低延迟本地盘（优先 SSD），避免网络盘
- 调低 `downloadConcurrency`、`uploadConcurrency`、`maxConcurrentMappings` 可在低配机器上保证稳定吞吐

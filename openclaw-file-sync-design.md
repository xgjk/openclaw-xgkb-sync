# OpenClaw x 知识库 文件双向同步设计文档（交付实现版）

> 更新日期：2026-05-07  
> 适用对象：OpenClaw 插件实现团队、知识库后端团队、运维团队  
> 目标：不依赖 Obsidian 客户端，在多节点 OpenClaw 环境实现“本地目录 <-> 知识库空间/目录”双向同步

---

## 1. 背景与目标

当前已有 Obsidian 插件同步能力，但业务需求已切换为：

- 多台 OpenClaw（云端 + 内网）持续产出文件
- 统一同步到知识库指定空间，且可限定到空间下某个目录
- 支持双向同步（中心更新回流到 OpenClaw）
- 不要求目标机器安装 Obsidian

### 1.1 同步边界

本方案的同步对象定义为：

- 本地：OpenClaw 节点上一个或多个“被配置为可同步的根目录”
- 云端：知识库中的 `projectId + rootFileId`（空间 + 目录）
- 文件类型：建议第一期仅 `.md`（与现有插件一致），后续可扩展白名单

### 1.2 非目标（一期不做）

- 富文本差量合并（如段落级 merge）
- 文件权限模型重构
- 双向 rename/move 高保真追踪（先按 delete + create 语义处理）

---

## 2. 参考现有插件的可复用能力（现状分析）

现有 `obsidian-xgkb-sync` 已有一条可迁移的稳定链路：

- 增量优先：`listChanges(since)` 拉变更事件
- 元数据对账：`batchGetMeta(fileIds)` 获取最新 `name/updateTime/parentId/deleted`
- 正文批量拉取：`batchGetContent(files)`，缺失项回退 `getFullFileContent(fileId)`
- 上传更新统一走：`uploadContent`（新建不传 `updateFileId`，更新传 `updateFileId`）
- 删除：`deleteFile(fileId)`
- 首次或增量失败时兜底：`listDescendantFiles` 全量扫描

同步决策策略（当前实现）：

- 基于本地状态库记录的 `localMtime/remoteMtime`
- 两端均改动时采用 LWW（Last-Write-Wins）
- 单端删除时按“是否发生新修改”判断传播删除或回补

以上机制已在生产化维度具备价值，可作为 OpenClaw 插件核心骨架。

---

## 3. OpenClaw 场景总体架构

## 3.1 组件划分

### A. OpenClaw Sync Agent（部署在每台 OpenClaw）

- 负责本地扫描、变更上报、远端拉取、冲突处理、状态持久化
- 支持多条映射规则（本地目录 <-> 云端空间目录）
- 通过配置中心或本地配置文件加载规则

### B. Knowledge Base API（已有）

- 复用已有文件接口：
  - `listChanges`
  - `batchGetMeta`
  - `batchGetContent`
  - `listDescendantFiles`
  - `uploadContent`
  - `deleteFile`
  - `createFolder`

### C. 运维与观测组件（新增建议）

- 同步任务日志（结构化）
- 失败重试队列监控
- 映射规则生效状态检查

## 3.2 网络模型要求

必须采用“节点主动连接中心”的模型：

- OpenClaw 节点定时 `pull` 云端变更
- 节点在检测到本地变更时 `push`
- 不依赖中心主动回连节点（兼容内网不可入站）

---

## 4. 配置模型设计（OpenClaw 插件）

建议配置结构如下：

```json
{
  "serverUrl": "https://xxx/open-api/",
  "appKey": "xxxxx",
  "syncDirection": "bidirectional",
  "autoSyncIntervalSec": 60,
  "mappings": [
    {
      "mappingId": "map-task-output-a",
      "enabled": true,
      "localRoot": "/data/openclaw/tasks/output-a",
      "projectId": "12345",
      "remoteRootFileId": "67890",
      "filePatterns": ["**/*.md"],
      "excludePatterns": ["**/_conflict_*", "**/.tmp/**"]
    }
  ]
}
```

关键约束：

- 同一 `localRoot` 不能映射到多个云端根（防止回环）
- 同一 `mappingId` 独立维护同步水位与状态
- 支持运行期热更新配置，但更新后应触发一次“轻量全量对账”

---

## 5. 本地状态库设计（重点评估）

现有插件使用 IndexedDB（Obsidian 环境）。OpenClaw 环境建议改为 SQLite（或 RocksDB）；推荐 SQLite，原因：

- 单机部署通用性高，运维简单
- 支持事务，便于“文件状态 + 水位”原子提交
- 可直接通过 SQL 做诊断与恢复

## 5.1 表结构建议

### `sync_mapping_state`

- `mapping_id` (PK)
- `last_sync_since` (BIGINT, nullable)  // 对应 listChanges 水位
- `last_server_time` (BIGINT, nullable)
- `last_success_at` (BIGINT)
- `last_error` (TEXT, nullable)

### `sync_file_state`

- `mapping_id` (PK part)
- `local_path` (PK part)                // 相对于 localRoot
- `remote_file_id` (INDEX)
- `remote_folder_id`
- `local_mtime`
- `remote_mtime`
- `content_hash` (nullable)
- `sync_status` (`done|failed`)
- `last_sync_at`
- `last_error` (nullable)

### `sync_op_log`（可选但强烈建议）

- `idempotency_key` (UNIQUE)
- `mapping_id`
- `op_type` (`upload|download|delete_local|delete_remote`)
- `target`
- `request_payload` (json)
- `result_payload` (json)
- `created_at`

## 5.2 是否必须保留“本地状态库”？

结论：**必须保留**。原因：

1. 仅靠 `mtime` 与目录扫描无法可靠判断“删除传播方向”
2. 增量模式需要 `remote_file_id <-> local_path` 映射来避免频繁全量扫描
3. 异常恢复需要可追溯状态（尤其是半成功场景）
4. 冲突处理需要“上次已知双端时钟点”

如果无本地状态库，系统将退化为“每轮全量对账 + 弱冲突判断”，成本与误判率都会显著上升。

---

## 6. 同步流程设计（流程级关系）

以下按“单个 mapping”描述。多 mapping 以串行或受控并发执行。

## 6.1 启动与初始化

1. 加载配置并校验
2. 打开本地状态库
3. 校验远端根目录：
   - 已存在：记录 `remoteRootFileId`
   - 不存在且允许自动创建：调用 `createFolder`
4. 读取 `sync_mapping_state.last_sync_since`

## 6.2 一轮同步总流程（增量优先）

1. 本地扫描：列出 `localRoot` 下匹配文件（建议只收敛为逻辑路径 + mtime + size）
2. 构建云端视图：
   - 有 `last_sync_since`：先 `listChanges(safeSince)`
   - 对 upsert 事件批量 `batchGetMeta`
   - 对新增未知 `fileId` 尝试路径重建；无法重建则降级全量
   - 增量链路失败也降级全量 `listDescendantFiles`
3. 以“路径并集”做决策（upload/download/delete/skip）
4. 批量预取下载内容：`batchGetContent`
5. 执行计划并更新本地状态库
6. 全部成功后提交新水位 `newSince = serverTime || now`

## 6.3 与知识库接口时序（关键）

### Pull（云 -> 本）

1. `listChanges(projectId, rootFileId, since/cursor)`
2. `batchGetMeta(fileIds)`（仅 upsert 集合）
3. `batchGetContent(fileIds)`（仅需下载集合）
4. 缺失项 `getFullFileContent(fileId)` 回退
5. 本地写文件
6. `sync_file_state` 更新 `remote_mtime/local_mtime`

### Push（本 -> 云）

1. 若新文件：`uploadContent(content,fileName,folderName)`
2. 若更新：`uploadContent(content,fileName,updateFileId=remote_file_id)`
3. 若删除：`deleteFile(remote_file_id)`
4. 回写 `sync_file_state`（含新 `remote_file_id/remote_folder_id`）

### 全量兜底（首次/降级）

1. `listDescendantFiles(rootFileId, cursor, includePath=true, suffix=md)`
2. 结合本地扫描结果做全量决策

---

## 7. 冲突与删除策略

## 7.1 默认策略（一期）

- 时间戳策略：LWW
- 删除策略：
  - 本地缺失 + 云端未变：传播删除到云端
  - 本地缺失 + 云端有新改动：回补下载到本地
  - 云端缺失 + 本地未变：本地删除
  - 云端缺失 + 本地有新改动：重新上传

## 7.2 冲突保底（建议）

当检测到“两端都改且时间戳接近/不可信”时：

- 可选落地 keep-both：
  - 保留当前目标文件
  - 另一版本写 `_conflict_<nodeId>_<timestamp>.md`
- 同步状态标记为 `done_with_conflict`

---

## 8. 可靠性设计

## 8.1 幂等与重试

- 每个写操作生成 `idempotencyKey`
- 请求失败按指数退避重试（如 1s/2s/4s）
- 401 不重试，直接告警配置问题

## 8.2 水位提交规则

- 仅当本轮“计划执行阶段”无系统性失败时推进 `last_sync_since`
- 部分文件失败时：
  - 可选择不推进水位（最稳，代价是下轮重复处理）
  - 或推进水位但失败项写入补偿队列（效率高，实现复杂）

建议一期采用“不完全成功不推进水位”的保守策略。

## 8.3 安全回拨窗口

- 调用 `listChanges` 时使用 `safeSince = last_sync_since - 5000ms`
- 避免由于服务端/客户端时钟偏差漏事件

---

## 9. 多映射与并发控制

## 9.1 执行模型

- 进程内：同一 `mappingId` 严格串行（加锁）
- 不同 `mappingId`：可并发，但建议限制并发度（如 2~4）

## 9.2 同步触发机制

- 定时触发（主）
- 事件触发（本地文件变更）可作为加速器，但仍需定时兜底

## 9.3 防重入

- 全局 `isSyncing` + mapping 级锁
- 新触发到来时若正在执行，合并为“待执行一次”

---

## 10. 接口能力缺口与后端协同建议

当前可基于现有接口落地，但建议后端补充以下能力以降低复杂度：

1. `listChanges` 增加更稳定的路径字段（减少路径重建逻辑）
2. `batchGetMeta` 返回明确的“无权限/不存在”区分码
3. 写接口支持显式 `idempotencyKey`
4. 可选提供“批量写文件”接口，降低高频任务场景 RTT

---

## 11. 迁移与实现建议（给实现团队）

## 11.1 代码分层建议

- `LocalFsAdapter`：替代 Obsidian Vault API，面向 Node.js `fs`
- `KbApiClient`：沿用现有 API 封装思想
- `SyncStateStore`：IndexedDB -> SQLite
- `SyncEngine`：决策与执行核心（可大量复用逻辑）
- `Scheduler`：定时/重试/并发控制

## 11.2 复用与改造清单

可直接复用思想：

- 增量优先 + 全量降级
- 路径并集合并决策
- batch 预取正文
- LWW 决策矩阵

必须改造：

- 本地 FS 访问层（Obsidian API -> Node 文件系统）
- 本地状态库（IndexedDB -> SQLite）
- 配置模型（单映射 -> 多映射）
- 运行形态（插件按钮触发 -> 后台服务）

---

## 12. 验收标准（可测试）

1. 配置一条映射后，OpenClaw 本地新建 `.md` 可在云端目标目录出现
2. 云端修改文件后，下一轮增量可回写本地
3. 任一端删除文件，另一端按策略正确传播
4. 模拟网络抖动与重试，不出现重复新建（幂等有效）
5. Agent 重启后可从状态库继续增量，不退化为每轮全量
6. 多映射同时运行，无互相污染（状态隔离）

---

## 13. 风险与治理

- 路径非法字符：必须统一 sanitize（双端一致）
- 时钟漂移：依赖安全回拨 + serverTime
- 大目录压力：需要分页、批处理、并发上限
- 权限变化：`batchGetMeta` 未返回项要有可观测告警

---

## 14. 结论

该需求可通过 OpenClaw 插件独立落地，不需要在节点安装 Obsidian。  
实现上应复用现有同步插件的“增量事件流 + 状态库驱动 + 全量兜底”核心机制，并将本地状态持久化升级为 SQLite、多映射化与服务化运行。  
只要按本文的接口时序和状态提交规则实施，即可在“云端 + 内网混部”的 OpenClaw 集群中稳定实现双向文件同步。


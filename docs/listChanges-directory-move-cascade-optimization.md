# listChanges 目录移动级联事件优化方案（待实施）

> **状态**：待优化 / 待联调  
> **日期**：2026-05-27  
> **范围**：知识库 `listChanges` 语义调整 + OpenClaw 同步客户端配套改造  
> **关联文档**：[kb-api-requirements-for-sync.md](./kb-api-requirements-for-sync.md)、[bidirectional-sync-analysis.md](./bidirectional-sync-analysis.md)、[rename-move-refactor-plan.md](./rename-move-refactor-plan.md)

---

## 1. 背景

### 1.1 当前 KB 行为（已确认）

根据联调约定与 [bidirectional-sync-analysis.md §8](./bidirectional-sync-analysis.md)：

| 操作 | listChanges 行为 |
|------|------------------|
| **rename**（同目录改名） | 仅 upsert **被改名的节点** |
| **move**（换父目录 / 目录移动） | upsert **被移动的节点 + 所有下级节点** |

目录 `moveFile` 成功后，即使子文件**内容未变**，也会因路径/metadata 级联更新而产生大量 `upsert` 事件。

### 1.2 同步客户端的实际处理方式

OpenClaw 同步服务对**本地发起的目录 move**：

1. Phase1 `detectFolderRenames` 检测本地目录 inode 变化；
2. 对目录 fileId 调用 **一次** `moveFile`；
3. 批量更新 SQLite 中该前缀下所有文件的 `localPath`（`doMoveRemoteDirectory`）；
4. 同轮 Phase2 通过 `consumedToPaths` 跳过子文件路径对账。

**结论**：本地 push 目录 move 后，客户端**不依赖**子文件的 listChanges upsert 来更新路径——路径已在 Phase1 写库。

---

## 2. 为什么要改

### 2.1 现状带来的问题

#### 问题 A：bidirectional 下的「回声放大」（本地 move 后）

| 步骤 | 现象 |
|------|------|
| 本地移动目录 `A/` → `B/`（含 N 个子文件） | Phase1 一次 `moveFile` + DB 批量改路径 |
| 下一轮 `listChanges` | 收到 N 条子文件 upsert（仅 `updateTime` 等 metadata 变化） |
| Phase2 `decide` | `remoteChanged=true`，`localChanged=false` → **`download-update × N`** |

- **不是严格死循环**（水位推进 + download 后 mtime 基线更新，通常 1～2 轮收敛）；
- 但会造成 **无意义的大量下载/API 调用**，大目录 move 后尤其明显；
- **push-only** 模式因 `remoteChanged` 走 `skip`，影响较小。

#### 问题 B：子文件 upsert 对「远端目录 move」帮助有限

OpenClaw 增量检测远端 rename/move 的逻辑是：比对 `batchGetMeta` 的 `parentId` + `name` 与 DB 记录是否变化。

目录 move 时，**叶子文件**常见情况：

- `fileId` 不变；
- **直接父目录 `parentId` 不变**（仍指向中间子文件夹 id）；
- `name` 不变；
- 仅 `updateTime` / 全路径 `relativePath` 变化。

此时即使 listChanges **返回了**所有子 upsert，增量也**不会**生成 `remoteMoveHint`，往往只会误触发 `download-update`，**仍不会**把本地目录从 `A/` 挪到 `B/`。

远端目录 move 的对齐，当前主要依赖 **全量** `listDescendantFiles` + `detectRemoteMovesFromFullScan`（默认间隔约 1 小时）。

#### 问题 C：API 与带宽浪费

大目录（数百～上千文件）每次 move 产生 N 条 upsert → N 次 `batchGetMeta` + 可能的 N 次 `readFile`，与「目录 move 应是一次结构性操作」的设计目标不符。

### 2.2 改动的预期收益

| 收益 | 说明 |
|------|------|
| 消除 push/bidirectional 本地 move 后的假 download | 子文件不再因纯路径级联进入 upsert |
| 降低 listChanges / batchGetMeta / readFile 压力 | 目录 move 从 O(N) 事件降为 O(1) |
| 语义更清晰 | listChanges 只反映「真正发生变更的节点」 |
| 与 rename 行为一致 | rename 已只报单节点，move 应对齐 |

---

## 3. 推荐方案（KB + 客户端联动）

> **不建议「只改 KB、不改客户端」长期运行。**  
> 可短期止血，但 pull/bidirectional 的远端目录 move 会更多依赖全量对账。

### 3.1 知识库侧：listChanges 语义调整

#### 3.1.1 核心规则

**move / rename 成功后，listChanges 只 upsert「被直接操作的节点」。**

下级节点若**仅因祖先路径级联**导致内部 `relativePath` 变化，且满足以下全部条件，则 **不应** 出现在 listChanges 中：

- 文件内容未变（无新版本 / 无 contentHash 变化）；
- `fileId` 未变（非 COVER 等 id 替换场景）；
- 该节点自身的直接 `parentId` 未变；
- 该节点自身的 `name` 未变；
- 无 delete / 新建。

#### 3.1.2 仍必须返回的情况

| 情况 | 必须返回 upsert/delete |
|------|------------------------|
| 子文件**内容**被修改 | ✅ |
| 子文件 **fileId 变化**（如 COVER 策略 id 替换） | ✅ |
| 子文件**自身** rename / move（直接 `parentId` 或 `name` 变） | ✅ |
| 子文件被删除 | ✅ delete |
| 新建文件 | ✅ |

#### 3.1.3 目录 move 事件应携带的信息

被移动的**目录节点** upsert 必须信息完整，供客户端推断整棵子树：

| 字段 | 要求 |
|------|------|
| `fileId` | 目录 id |
| `type` | 文件夹类型 |
| `parentId` | 移动后的父目录 id |
| `name` | 目录名 |
| `updateTime` | 有值 |
| `relativePath` | `includePath=true` 且传 `rootFileId` 时返回 |
| `previousParentId` / `previousName` | `includeMoveHint=true` 时尽量返回（Redis hint，见 kb-api §5.4） |

> **Obsidian 插件**已实现 `applyFolderUpsertsToPathMap` 处理目录 upsert；OpenClaw **尚未实现**，需作为客户端改造项。

#### 3.1.4 与现有文档的差异

当前 [bidirectional-sync-analysis.md §8](./bidirectional-sync-analysis.md) 记录：

> listChanges 行为：rename 仅更新本条；**move 更新本条+所有下级**

本方案建议将 move 改为与 rename 对齐：**仅更新被 move 的节点**（外加 §3.1.2 中真实变更的下级）。

实施后需同步更新该文档及 [kb-api-requirements-for-sync.md](./kb-api-requirements-for-sync.md) 中的行为描述。

---

### 3.2 同步客户端侧：配套改造

#### 3.2.1 P0 — move 后刷新 remote mtime（防御性，可独立先做）

**位置**：`syncEngine.ts` → `doMoveRemoteDirectory` / `doRenameRemoteDirectory`

**问题**：目录 move 成功后，`affectedRecords` 的 `remoteMtime` 仍保留旧值；下一轮若仍有子 upsert（KB 未改或灰度期间），会误判 `remoteChanged`。

**改法**：

- 目录 move/rename 成功后，对 `affectedRecords` 批量 `batchGetMeta`，将 `remoteMtime` 更新为 KB 当前 `updateTime`；
- 或在 `moveFile` / `updateFileName` 响应中若含子树 metadata，直接写入 DB。

**价值**：即使 KB 暂未改 listChanges，也能显著降低 bidirectional 误 download 概率。

#### 3.2.2 P1 — 处理目录 upsert（远端 → 本地 move 增量对齐）

**位置**：`syncEngine.ts` → `tryIncrementalRemoteMap`

**参考**：Obsidian 插件 `applyFolderUpsertsToPathMap` + `XGKB_NODE_FOLDER` 类型判断。

**改法概要**：

1. 从 `listChanges` items 中识别 **文件夹类型** upsert；
2. 维护 / 更新 `folderIdToPath`（目录 id → 本地逻辑路径）；
3. 检测到目录 `parentId` 或 `name` 变化 → 推导 `oldPath` / `newPath`；
4. 生成 **目录级** `RemoteMoveHint`（`isDirectory=true`）；
5. Phase1.5 调用已有 `doRemoteDirMoveToLocal`：一次 `fs.rename` + `renameFilePaths` / `renameFolderPaths`。

**价值**：KB 改为只报目录 upsert 后，pull/bidirectional 仍能在**增量**内对齐远端目录 move，而不必等全量。

#### 3.2.3 P1 — metadata-only upsert 跳过 download

**位置**：`syncEngine.ts` → `decide()` 或 `tryIncrementalRemoteMap` 构建 remoteMap 后

**规则**（建议）：

```
若同时满足：
  - record 存在且 syncStatus=done
  - lastSyncAt 在 recent 窗口内（如 10 分钟，可配置）
  - 本地路径与 DB 一致，remoteMap 路径与 DB 一致
  - upsert 仅 updateTime 变化，parentId/name/content 均未变
则：
  - 更新 record.remoteMtime 为 meta.updateTime
  - decide → skip（不 download-update）
```

**价值**：兼容 KB 灰度、历史行为、其他客户端触发的 metadata 刷新。

#### 3.2.4 P2 — 自触发 move tombstone（可选）

**思路**：本地 Phase1 成功 move 的 `fileId` 集合，写入 mapping 级短期 tombstone（SQLite 或内存，TTL 1～2 轮 sync）。

**用途**：下一轮 listChanges 即使仍收到这些 id 的 upsert，也按 metadata-only 处理或直接 skip。

**参考**：Obsidian 插件 `pendingRemoteOp` 队列语义（本客户端当前无 pending 机制）。

---

## 4. 分场景影响评估

### 4.1 本地发起目录 move（push / bidirectional）

| 项目 | KB 改后 | 说明 |
|------|---------|------|
| 本地磁盘路径 | ✅ 无影响 | 用户已 move；Phase1 已推远端 |
| SQLite 路径 | ✅ 无影响 | Phase1 已 `renameFilePaths` |
| 下轮 listChanges | 仅目录 0～1 条 upsert | 子文件走 DB「未变更」分支 |
| Phase2 决策 | skip | 无假 download |
| enableFileIndex | ✅ 无影响 | 下轮 publish 从 SQLite 全量生成 |

**前提**：Phase1 `doMoveRemoteDirectory` 必须成功完成；若 moveFile 成功但 DB 批量更新失败，需靠失败标记与下轮重试，与现逻辑一致。

### 4.2 远端发起目录 move（pull / bidirectional）

| 项目 | 仅改 KB、不改客户端 | KB + 客户端 §3.2.2 |
|------|---------------------|---------------------|
| 增量对齐子树 | ❌ 依赖全量（~1h） | ✅ 目录 upsert → `doRemoteDirMoveToLocal` |
| 本地路径滞后 | 最长一个全量间隔 | 下一轮 incremental 应对齐 |
| 误 download | 减少（无 mass upsert） | 减少 + metadata-only skip |

### 4.3 COVER 策略下 fileId 变化

若 `moveFile` 返回 `idMappings` 且部分子节点 id 真正变化：

- 这些节点属于 §3.1.2「必须返回」；
- 客户端 Phase1 已通过 `applyRemoteIdMappings` 更新 DB（现有逻辑）；
- listChanges 也应对这些 id 返回 upsert，客户端走 knownUpsert 刷新 meta。

---

## 5. 重点注意事项

### 5.1 ⚠️ 不要 suppress「真实变更」

KB 实现时务必区分：

- **路径级联**（ancestor move 导致 relativePath 变，节点自身 metadata 不变）→ 不返回；
- **真实变更**（内容、id、直接 parent、name、delete）→ 必须返回。

否则会导致**静默丢同步**。

### 5.2 ⚠️ KB 改动与客户端必须版本对齐

建议发布顺序：

1. **客户端先发** P0（refresh remoteMtime）+ P1（metadata-only skip）— 兼容旧 KB；
2. **KB 切换** listChanges 新语义（可 feature flag）；
3. **客户端发** P1（目录 upsert 处理）— 依赖 KB 目录事件完整；
4. 联调通过后更新文档，移除旧行为描述。

若 KB 先改、客户端未处理目录 upsert：**远端目录 move 在增量内不可见**，只能等全量，窗口内本地目录结构错误（见 §4.2）。

### 5.3 ⚠️ 与 Obsidian 插件对齐

Obsidian 插件（`obsidian-xgkb-sync`）已具备：

- `applyFolderUpsertsToPathMap`（目录 upsert → 路径映射）；
- `pendingRemoteOp`（自触发 move 消费 / 清理）；
- `buildFolderIdToPathFromRecords` 在 pending 时用 `oldPath` 防污染。

OpenClaw 改造时应**复用相同契约**，避免同一 KB 行为在两套客户端表现不一致。

### 5.4 ⚠️ 增量 move 检测的固有限制

即使不改 listChanges，OpenClaw 对「叶子 parentId 不变」的目录 move **增量本就不生成 move hint**。  
改 listChanges **不能单独**解决所有远端 move 场景；**目录 upsert + 全量兜底** 仍是必要组合。

### 5.5 ⚠️ push-only 部署可降级优先级

若生产环境仅使用 **push** 模式：

- 问题 A（假 download）影响小（push 对 remote-only 变更 skip）；
- 仍可优先做 KB 改动以降低 API 压力；
- 客户端 P1 目录 upsert 可延后。

### 5.6 ⚠️ 全量对账仍是最后防线

无论 listChanges 如何优化，需保留：

- 周期性 `fullReconcileIntervalSec` 全量；
- `detectRemoteMovesFromFullScan` 目录级 80% 聚合；
- 远端列表异常时 **禁止批量 delete-local**（见 suffix 事故复盘，独立待办）。

---

## 6. 建议实施优先级

| 优先级 | 项 | 负责 | 依赖 |
|--------|-----|------|------|
| **P0** | 客户端：move 后刷新 `remoteMtime` | OpenClaw | 无 |
| **P0** | 客户端：metadata-only upsert → skip download | OpenClaw | 无 |
| **P1** | KB：move 仅 upsert 被操作节点 + 目录事件信息完整 | KB | 无 |
| **P1** | 客户端：目录 upsert → `doRemoteDirMoveToLocal` | OpenClaw | KB P1 |
| **P2** | 客户端：自触发 move tombstone | OpenClaw | 可选 |
| **P2** | 文档：更新 bidirectional-sync-analysis §8、kb-api §5.3 | 联调后 | KB 上线 |

---

## 7. 验收标准

### 7.1 本地目录 move（bidirectional，100+ 文件）

1. 本地 `A/` → `B/`，触发 sync；
2. 日志：Phase1 **1 次** `moveFile`，非 N 次；
3. 下一轮 sync：**0 次** `download-update`（或仅目录节点相关 0～1 次 meta 刷新）；
4. SQLite / 本地磁盘路径均为 `B/...`；
5. KB 侧文件仍在正确位置，内容未重复上传。

### 7.2 远端目录 move（bidirectional）

1. 仅在 KB UI 移动目录 `A/` → `B/`；
2. 下一轮 incremental：客户端识别目录 upsert；
3. 本地一次 `fs.rename`，所有子文件路径前缀更新；
4. **无需等待全量**即可对齐（全量仍作兜底）。

### 7.3 子文件内容变更不受影响

1. 目录 move 后，单独修改某子文件内容；
2. 该子文件 upsert **仍出现在** listChanges；
3. 客户端正常 `download-update` 或 `upload-update`（按方向与冲突策略）。

### 7.4 COVER / idMappings

1. move 导致部分 id 变化；
2. 变化 id 出现在 listChanges；
3. 客户端 DB `remoteFileId` 与 KB 一致。

---

## 8. 结论

| 问题 | 建议 |
|------|------|
| listChanges move 是否改为「只报被移动节点」？ | **建议改** |
| 能否只改 KB？ | **不够**；需客户端目录 upsert + mtime 刷新 |
| 能否保持现状？ | **不推荐**；bidirectional 假 download + API 浪费，且对远端 move 增量帮助有限 |

**推荐路径**：客户端 P0 止血 → KB 调整 listChanges 语义 → 客户端 P1 目录 upsert 对齐 → 联调验收 → 更新 API 文档。

---

## 9. 相关代码锚点（OpenClaw）

| 模块 | 文件 | 说明 |
|------|------|------|
| 增量 listChanges | `src/syncEngine.ts` → `tryIncrementalRemoteMap` | 已知/未知 upsert 分类、remoteMoveHints |
| 目录 move 推远端 | `src/syncEngine.ts` → `doMoveRemoteDirectory` | 一次 moveFile + 批量改 DB 路径 |
| 目录 move 拉本地 | `src/syncEngine.ts` → `doRemoteDirMoveToLocal` | fs.rename + renameFilePaths |
| 全量 move 检测 | `src/syncEngine.ts` → `detectRemoteMovesFromFullScan` | 仅 fullScan 路径 |
| Phase1 消费路径 | `src/reconcileEngine.ts` → `detectFolderRenames` | consumedToPaths |
| 决策 | `src/syncEngine.ts` → `decide` | remoteChanged → download-update |
| Obsidian 参考 | `obsidian-xgkb-sync/src/syncEngine.ts` | `applyFolderUpsertsToPathMap`、`pendingRemoteOp` |

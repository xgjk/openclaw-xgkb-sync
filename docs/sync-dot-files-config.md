# 点文件 / 点目录同步配置（syncDotFiles）

> **状态**：已实现  
> **相关代码**：`src/pathSyncScope.ts`、`src/localFs.ts`、`src/fileWatcher.ts`  
> **默认值**：`syncDotFiles: false`（与改造前行为一致）

---

## 1. 背景

早期实现中，本地 walk / watch **硬编码**跳过任意以 `.` 开头的文件名/目录名（如 `.git`、`.env`、`notes/.config.md`）。  
唯一例外是 mapping 根目录的 `.openclaw-sync-map.json`——它不走普通 filePatterns，而由 `enableFileIndex` 独立通道 publish/consume。

该硬编码无法通过 `excludePatterns` 调整，也无法按需同步非根目录点文件（Obsidian 插件则支持匹配扩展名的点文件）。

---

## 2. 配置项

### 2.1 全局（`config.json` 根级）

```json
{
  "syncDotFiles": false,
  "mappings": [ ... ]
}
```

### 2.2 mapping 级（覆盖全局）

```json
{
  "mappingId": "map-example",
  "localRoot": "/data/openclaw/out",
  "filePatterns": ["**/*.md"],
  "excludePatterns": ["**/_conflict_*", "**/.git/**"],
  "syncDotFiles": true
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `syncDotFiles` | `boolean` | `false` | 是否将「点路径段」纳入同步范围 |

**生效优先级**：`mapping.syncDotFiles` → 全局 `syncDotFiles` → 默认 `false`。

---

## 3. 与 filePatterns / excludePatterns 的配合

同步范围由 **`pathSyncScope`** 统一判定，顺序如下：

```
1. syncDotFiles === false
   → 任意路径段以 `.` 开头则排除（在 glob 之前）
2. excludePatterns 匹配则排除
3. 文件还需 filePatterns 匹配；目录仅受 1、2 约束（便于 inode 目录对账）
```

### 3.1 默认（`syncDotFiles: false`）——推荐大多数场景

| 路径 | 结果 |
|------|------|
| `notes/readme.md` | 由 filePatterns / excludePatterns 决定 |
| `.env` | **不同步** |
| `notes/.secret.md` | **不同步** |
| `.git/config` | **不同步**（`.git` 目录不会被 traverse） |
| `.openclaw-sync-map.json`（根） | walk **跳过**；`enableFileIndex=true` 时仍独立同步 |

与改造前行为一致。

### 3.2 开启点文件（`syncDotFiles: true`）

点路径与普通路径**同等对待**，仅由 glob 过滤：

```json
{
  "syncDotFiles": true,
  "filePatterns": ["**/*.md", "**/.env.example"],
  "excludePatterns": [
    "**/_conflict_*",
    "**/.git/**",
    "**/.obsidian/**",
    "**/.vscode/**",
    "**/.cache/**",
    "**/.tmp/**"
  ]
}
```

| 路径 | 结果 |
|------|------|
| `notes/.cursorrules` | 若匹配 `filePatterns` 且未命中 exclude → **同步** |
| `config/.env.example` | 若显式加入 filePatterns → **同步** |
| `.git/HEAD` | 命中 `**/.git/**` → **不同步** |
| `.obsidian/workspace.json` | 命中 exclude → **不同步** |

> **建议**：开启 `syncDotFiles` 时，在 `excludePatterns` 中显式排除工具目录。  
> 可参考 `src/constants.ts` 中的 `RECOMMENDED_DOT_DIR_EXCLUDE_PATTERNS`（文档参考，不会自动注入配置）。

### 3.3 仅用 excludePatterns 排除特定点目录（不关 syncDotFiles）

若只想排除 `.git` 但保留其他点文件，应 **`syncDotFiles: true` + excludePatterns`**。  
在 `syncDotFiles: false` 下，所有点路径已被整体排除，exclude 中的 `**/.git/**` 无额外作用。

---

## 4. 影响范围

| 模块 | 行为 |
|------|------|
| `LocalFsAdapter.listFiles` / `listDirectories` | 使用 `syncDotFiles` |
| `FileWatcher`（chokidar ignored） | 与 walk 一致 |
| `RemoteFsAdapter.listFiles` | 远端列表结果同样过滤 |
| `SyncEngine.matchesSync` | 增量/全量远端路径对账一致 |

**不受 `syncDotFiles` 影响**：

- `.openclaw-sync-map.json`：`FileIndexService` 独立通道；watch 仍硬排除该文件，避免 consume 写入触发 echo push。

---

## 5. 与 Obsidian 插件的差异

| 能力 | Obsidian 插件 | OpenClaw 同步服务 |
|------|---------------|-------------------|
| 非根点 **文件** | 支持（匹配扩展名） | `syncDotFiles: true` 时支持 |
| 点 **目录** | 跳过（不 traverse） | `syncDotFiles: false` 跳过；`true` 时由 excludePatterns 控制 |
| 配置方式 | 内置逻辑 | **`syncDotFiles` + excludePatterns** |

---

## 6. 常见场景示例

### 6.1 仅同步 Markdown（默认）

```json
{
  "syncDotFiles": false,
  "filePatterns": ["**/*.md"],
  "excludePatterns": ["**/_conflict_*", "**/.tmp/**"]
}
```

### 6.2 同步部分点文件（如 `.cursorrules`）

```json
{
  "syncDotFiles": true,
  "filePatterns": ["**/*.md", "**/.cursorrules", "**/.env.example"],
  "excludePatterns": [
    "**/_conflict_*",
    "**/.git/**",
    "**/.obsidian/**",
    "**/.openclaw-sync-map.json"
  ],
  "enableFileIndex": true
}
```

> 若开启 `enableFileIndex`，建议在 exclude 中保留 `.openclaw-sync-map.json`，避免与普通 upload 重复。

### 6.3 mapping 级差异化

```json
{
  "syncDotFiles": false,
  "mappings": [
    {
      "mappingId": "map-public",
      "filePatterns": ["**/*.md"]
    },
    {
      "mappingId": "map-with-dot-config",
      "syncDotFiles": true,
      "filePatterns": ["**/*.md", "**/.cursorrules"],
      "excludePatterns": ["**/_conflict_*", "**/.git/**", "**/.obsidian/**"]
    }
  ]
}
```

---

## 7. 注意事项

1. **默认 `false` 保证升级兼容**：未配置时行为与硬编码时期相同。  
2. **`syncDotFiles` 不是 glob**：它只控制「点路径段」是否参与；具体哪些后缀/sync 仍靠 `filePatterns`。  
3. **exclude 优先于 include**：即使 `syncDotFiles: true`，命中 `excludePatterns` 仍不同步。  
4. **修改后需 reload**：通过管理 API `POST /reload` 或重启进程使配置生效。  
5. **已同步点文件再改 `false`**：不会自动删远端；后续对账可能产生 delete-remote（取决于 syncDirection），请谨慎切换。

---

## 8. 管理 API

- 全局：`PUT /config`  body `{ "syncDotFiles": true }`  
- mapping：`PUT /mappings/:id` body `{ "syncDotFiles": true, "excludePatterns": [...] }`  
- 查询：`GET /mappings/:id` 返回 `syncDotFiles` 与 `effectiveSyncDotFiles`

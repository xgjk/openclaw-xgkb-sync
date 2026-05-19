// ==================== 配置类型 ====================

export interface SyncMapping {
  mappingId: string;
  enabled: boolean;
  localRoot: string;
  /**
   * 单条 mapping 的 API 鉴权密钥，用于多用户/多身份场景。
   * 填写后优先于全局 appKey，不填则使用全局 appKey。
   */
  appKey?: string;
  /**
   * 知识库空间 ID。
   * 可不填：若不填则 Agent 启动时自动调用 getPersonalProjectId() 获取个人空间 ID。
   */
  projectId?: string;
  /**
   * 用于 listChanges / listDescendantFiles 的远端根目录 fileId。
   * 可不填：若不填且配置了 remoteRootFolderPath，则 Agent 启动时通过路径解析获得；
   * 两者都不填时表示同步整个 projectId 空间的根目录。
   */
  remoteRootFileId?: string;
  /**
   * 远端根目录的完整路径（"/" 分隔），例如 "OpenClaw/OutputA"。
   * 同时作为 uploadContent 的 folderName 前缀使用。
   * 若不填，Agent 启动时会通过 batchGetMeta 逐级向上解析（需额外 API 调用）。
   * 推荐填写以获得最佳性能。
   */
  remoteRootFolderPath?: string;
  /** 文件匹配模式，默认 ["**\/*.md"] */
  filePatterns?: string[];
  /** 排除模式，默认 ["**\/_conflict_*", "**\/.tmp\/**"] */
  excludePatterns?: string[];
  /**
   * 单条 mapping 的同步方向，覆盖全局配置。
   * 若不填，则使用全局 syncDirection。
   */
  syncDirection?: 'bidirectional' | 'push' | 'pull';
}

export interface SyncConfig {
  /** 知识库 Open API 根地址；省略时使用生产环境默认地址（见 constants.DEFAULT_SERVER_URL） */
  serverUrl: string;
  /**
   * 全局 API 密钥。可省略或留空；与单条 mapping 的 `appKey` 至少其一有值时才能正常调用知识库 API。
   */
  appKey?: string;
  syncDirection: 'bidirectional' | 'push' | 'pull';
  /** 自动同步间隔（秒），0 表示关闭 */
  autoSyncIntervalSec: number;
  /** SQLite 状态库路径，默认 ./openclaw-sync-state.db */
  stateDbPath?: string;
  /** 最大并发 mapping 数量，默认 2 */
  maxConcurrentMappings?: number;
  /**
   * API 限速：每分钟最大请求数（令牌桶稳态速率），默认 60。
   * 多台服务器共享同一知识库时，建议各自降低此值（如 30）以避免聚合超限。
   */
  maxRequestsPerMinute?: number;
  /**
   * 令牌桶突发容量，默认 8。
   * 允许短时间内连续发出最多 burst 个请求，随后按 maxRequestsPerMinute 补充。
   */
  rateLimitBurst?: number;
  /**
   * 收到 429 后的冷却时间（秒），默认 60。
   * 冷却期间所有请求排队等待，不会继续打穿限流。
   */
  rateLimitCooldownSec?: number;
  /**
   * 下载并发数，默认 5。控制同时进行的文件下载操作数量。
   */
  downloadConcurrency?: number;
  /**
   * 上传并发数，默认 3。控制同时进行的文件上传操作数量。
   */
  uploadConcurrency?: number;
  /**
   * 启动后首次同步的随机抖动上限（秒），默认 20。
   * 多台服务器同时启动时，随机延迟可分散请求突刺。设为 0 禁用抖动。
   */
  startupJitterMaxSec?: number;
  /**
   * HTTP 管理 API 监听端口，默认 9090。设为 0 禁用管理 API。
   */
  managementPort?: number;
  /**
   * HTTP 管理 API 监听地址，默认 "0.0.0.0"（允许局域网访问；本机浏览器请用 127.0.0.1）。
   * 注意做好网络隔离，勿在公网暴露。
   */
  managementHost?: string;
  mappings: SyncMapping[];
}

// ==================== 工具类型 ====================

export type ApiOk<T> = { ok: true; value: T };
export type ApiErr = { ok: false; error: string };
export type ApiResult<T> = ApiOk<T> | ApiErr;

// ==================== 本地文件类型 ====================

export interface LocalFileEntry {
  /** 相对于 localRoot 的路径，如 "日常笔记/2024.md" */
  path: string;
  name: string;
  mtime: number;
  size: number;
}

// ==================== 远端文件类型 ====================

export interface RemoteFileEntry {
  path: string;
  name: string;
  mtime: number;
  size?: number;
  remoteFileId: string;
  remoteFolderId: string;
}

// ==================== API 接口类型 ====================

export interface ListChangesItem {
  fileId: string | number;
  event: 'create' | 'update' | 'delete' | string;
  name?: string;
  updateTime?: number;
  parentId?: string | number | null;
}

export interface ListChangesResponse {
  items: ListChangesItem[];
  nextCursor?: string | null;
  serverTime?: number;
}

export interface ListDescendantFilesParams {
  rootFileId: string;
  projectId?: string;
  suffix?: string;
  limit?: number;
  cursor?: string;
  includePath?: boolean;
}

export interface ListDescendantFilesItem {
  fileId: string | number;
  name: string;
  relativePath?: string;
  updateTime?: number;
  size?: number;
  parentId?: string | number | null;
  type?: number;
}

export interface ListDescendantFilesResponse {
  files: ListDescendantFilesItem[];
  nextCursor?: string | null;
}

/** batchGetMeta 返回的元数据（fileId 字段） */
export interface FileMeta {
  fileId: string | number;
  name: string;
  updateTime?: number;
  parentId?: string | number | null;
  deleted?: boolean;
  type?: number;
}

/** getLevel1Folders / getChildFiles 返回的目录/文件项（id 字段） */
export interface FileListItem {
  id: string | number;
  name: string;
  type: number;
  parentId?: string | number | null;
  suffix?: string;
  size?: number;
  hasChild?: boolean;
  updateTime?: number;
}

export interface BatchGetContentItem {
  fileId: string | number;
  status?: string;
  content?: string;
}

export interface DownloadInfoVO {
  fileId: string | number;
  downloadUrl?: string;
  previewUrl?: string;
  fileName?: string;
  suffix?: string;
  size?: number;
}

export interface UploadContentParams {
  content: string;
  fileName: string;
  fileSuffix?: string;
  folderName?: string;
  updateFileId?: string;
  versionRemark?: string;
  projectId?: string;
}

export interface UploadContentResult {
  fileId: string | number;
  folderId?: string | number | null;
}

export interface CreateFolderParams {
  projectId: string;
  parentId: string;
  name: string;
}

export interface ListChangesParams {
  projectId: string;
  /** 不传时扫描整个 projectId 空间（等价于传项目根 rootFileId=0） */
  rootFileId?: string;
  since?: number;
  cursor?: string;
  limit?: number;
}

// ==================== 状态库类型 ====================

export interface MappingState {
  mappingId: string;
  lastSyncSince?: number | null;
  lastServerTime?: number | null;
  lastSuccessAt?: number | null;
  lastError?: string | null;
  /** 从 remoteRootFolderPath 解析后缓存的 rootFileId，避免每次启动重新解析 */
  resolvedRootFileId?: string | null;
  /** 自动解析或手动配置的 projectId 缓存 */
  resolvedProjectId?: string | null;
}

export interface FileState {
  mappingId: string;
  localPath: string;
  remoteFileId?: string | null;
  remoteFolderId?: string | null;
  localMtime?: number | null;
  remoteMtime?: number | null;
  contentHash?: string | null;
  syncStatus: 'done' | 'failed' | 'done_with_conflict';
  lastSyncAt?: number | null;
  lastError?: string | null;
}

// ==================== 同步引擎类型 ====================

export type SyncOp =
  | 'upload-new'
  | 'upload-update'
  | 'download-new'
  | 'download-update'
  | 'delete-local'
  | 'delete-remote'
  | 'skip';

export interface SyncPlan {
  path: string;
  local?: LocalFileEntry;
  remote?: RemoteFileEntry;
  record?: FileState;
  op: SyncOp;
}

export interface SyncStats {
  uploaded: number;
  downloaded: number;
  deleted: number;
  skipped: number;
  failed: number;
  errors: string[];
  newSince?: number;
}

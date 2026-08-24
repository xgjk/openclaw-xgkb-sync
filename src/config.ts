import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { SyncConfig, SyncMapping } from './types';
import {
  DEFAULT_AUTO_SYNC_INTERVAL_SEC,
  DEFAULT_AUTO_UPGRADE_ENABLED,
  DEFAULT_CENTRAL_HEARTBEAT_INTERVAL_SEC,
  DEFAULT_CENTRAL_MANAGER_URL,
  DEFAULT_DB_PATH,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_FILE_PATTERNS,
  DEFAULT_FULL_RECONCILE_INTERVAL_SEC,
  DEFAULT_MANAGEMENT_HOST,
  DEFAULT_MANAGEMENT_PORT,
  DEFAULT_MASS_SYNC_PROTECTION_ENABLED,
  DEFAULT_MAX_DOWNLOAD_FILES_PER_SYNC,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_MAX_UPLOAD_FILES_PER_SYNC,
  DEFAULT_MAX_CONCURRENT_MAPPINGS,
  DEFAULT_MAX_REQUESTS_PER_MINUTE,
  DEFAULT_RATE_LIMIT_BURST,
  DEFAULT_PUSH_DEBOUNCE_MS,
  DEFAULT_SERVER_URL,
  DEFAULT_SYNC_DOT_FILES,
  DEFAULT_WATCH_ENABLED,
  DEFAULT_WATCH_USE_POLLING,
  DOWNLOAD_CONCURRENCY,
  MAX_CONCURRENT_MAPPINGS_LIMIT,
  MAX_DOWNLOAD_CONCURRENCY,
  MAX_FILE_SIZE_BYTES_LIMIT,
  MAX_FILES_PER_SYNC_LIMIT,
  MAX_RATE_LIMIT_BURST,
  MAX_REQUESTS_PER_MINUTE_LIMIT,
  MAX_UPLOAD_CONCURRENCY,
  RATE_LIMIT_COOLDOWN_MS,
  STARTUP_JITTER_MAX_MS,
  UPLOAD_CONCURRENCY,
} from './constants';

const DEFAULT_CONFIG_PATH = './config.json';

/** 将外部资源配置收敛为正整数，并设置硬上限，避免 0 死循环或超大并发。 */
export function boundedPositiveInteger(
  raw: unknown,
  fallback: number,
  max: number,
  label: string,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    if (raw !== undefined) {
      console.warn(`[Config] ${label}=${String(raw)} 无效，已使用安全默认值 ${fallback}`);
    }
    return fallback;
  }
  const value = Math.max(1, Math.floor(raw));
  if (value > max) {
    console.warn(`[Config] ${label}=${value} 超过安全上限，已限制为 ${max}`);
    return max;
  }
  return value;
}

export type LoadConfigResult = {
  config: SyncConfig;
  /** 本次是否新建或回填/合并了 config.json */
  bootstrapped: boolean;
};

/**
 * 默认 config.json 内容（可序列化对象，不含 appKey）。
 * 服务可在无 mapping、无密钥时启动，通过 Web 控制台或管理 API 后续补全。
 */
export function getDefaultConfigRaw(): Record<string, unknown> {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    syncDirection: 'bidirectional',
    autoSyncIntervalSec: DEFAULT_AUTO_SYNC_INTERVAL_SEC,
    fullReconcileIntervalSec: DEFAULT_FULL_RECONCILE_INTERVAL_SEC,
    stateDbPath: DEFAULT_DB_PATH,
    maxConcurrentMappingsMode: 'auto',
    maxConcurrentMappings: DEFAULT_MAX_CONCURRENT_MAPPINGS,
    maxRequestsPerMinute: DEFAULT_MAX_REQUESTS_PER_MINUTE,
    rateLimitBurst: DEFAULT_RATE_LIMIT_BURST,
    rateLimitCooldownSec: RATE_LIMIT_COOLDOWN_MS / 1000,
    downloadConcurrency: DOWNLOAD_CONCURRENCY,
    uploadConcurrency: UPLOAD_CONCURRENCY,
    maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
    massSyncProtectionEnabled: DEFAULT_MASS_SYNC_PROTECTION_ENABLED,
    maxUploadFilesPerSync: DEFAULT_MAX_UPLOAD_FILES_PER_SYNC,
    maxDownloadFilesPerSync: DEFAULT_MAX_DOWNLOAD_FILES_PER_SYNC,
    startupJitterMaxSec: STARTUP_JITTER_MAX_MS / 1000,
    managementPort: DEFAULT_MANAGEMENT_PORT,
    managementHost: DEFAULT_MANAGEMENT_HOST,
    watchEnabled: DEFAULT_WATCH_ENABLED,
    pushDebounceMs: DEFAULT_PUSH_DEBOUNCE_MS,
    watchUsePolling: DEFAULT_WATCH_USE_POLLING,
    syncDotFiles: DEFAULT_SYNC_DOT_FILES,
    centralManagerUrl: DEFAULT_CENTRAL_MANAGER_URL,
    centralHeartbeatIntervalSec: DEFAULT_CENTRAL_HEARTBEAT_INTERVAL_SEC,
    autoUpgradeEnabled: DEFAULT_AUTO_UPGRADE_ENABLED,
    mappings: [],
  };
}

/** 将内存中的 SyncConfig 转为可写入 config.json 的对象（省略 undefined 字段） */
export function configToRaw(config: SyncConfig): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    serverUrl: config.serverUrl,
    syncDirection: config.syncDirection,
    autoSyncIntervalSec: config.autoSyncIntervalSec,
    fullReconcileIntervalSec: config.fullReconcileIntervalSec,
    stateDbPath: config.stateDbPath,
    maxConcurrentMappingsMode: config.maxConcurrentMappingsMode,
    maxConcurrentMappings: config.maxConcurrentMappings,
    maxRequestsPerMinute: config.maxRequestsPerMinute,
    rateLimitBurst: config.rateLimitBurst,
    rateLimitCooldownSec: config.rateLimitCooldownSec,
    downloadConcurrency: config.downloadConcurrency,
    uploadConcurrency: config.uploadConcurrency,
    maxFileSizeBytes: config.maxFileSizeBytes,
    massSyncProtectionEnabled: config.massSyncProtectionEnabled,
    maxUploadFilesPerSync: config.maxUploadFilesPerSync,
    maxDownloadFilesPerSync: config.maxDownloadFilesPerSync,
    startupJitterMaxSec: config.startupJitterMaxSec,
    managementPort: config.managementPort,
    managementHost: config.managementHost,
    watchEnabled: config.watchEnabled,
    pushDebounceMs: config.pushDebounceMs,
    watchUsePolling: config.watchUsePolling,
    syncDotFiles: config.syncDotFiles,
    mappings: config.mappings,
  };
  if (config.appKey) raw.appKey = config.appKey;
  if (config.localConfigVersion != null) raw.localConfigVersion = config.localConfigVersion;
  if (config.centralManagerUrl) raw.centralManagerUrl = config.centralManagerUrl;
  if (config.centralHeartbeatIntervalSec != null) {
    raw.centralHeartbeatIntervalSec = config.centralHeartbeatIntervalSec;
  }
  if (config.autoUpgradeEnabled != null) {
    raw.autoUpgradeEnabled = config.autoUpgradeEnabled;
  } else {
    raw.autoUpgradeEnabled = DEFAULT_AUTO_UPGRADE_ENABLED;
  }
  if (config.autoUpgradeScript) raw.autoUpgradeScript = config.autoUpgradeScript;
  if (config.nodeId) raw.nodeId = config.nodeId;
  if (config.nodeAdvertiseIp) raw.nodeAdvertiseIp = config.nodeAdvertiseIp;
  return raw;
}

/** 原子写入 config.json */
export function writeConfigFile(configPath: string, raw: Record<string, unknown>): void {
  const absPath = path.resolve(configPath);
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = absPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, absPath);
}

function isEmptyConfigRaw(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw !== 'object' || Array.isArray(raw)) return true;
  return Object.keys(raw as Record<string, unknown>).length === 0;
}

function isIncompleteConfigRaw(obj: Record<string, unknown>): boolean {
  const defaults = getDefaultConfigRaw();
  for (const key of Object.keys(defaults)) {
    if (key === 'mappings') {
      if (!Array.isArray(obj.mappings)) return true;
      continue;
    }
    if (!(key in obj)) return true;
  }
  return false;
}

/** 用默认值补全部分配置；保留用户已填的 appKey、mappings 等字段 */
function mergeWithDefaultConfigRaw(partial: Record<string, unknown>): Record<string, unknown> {
  const defaults = getDefaultConfigRaw();
  const merged: Record<string, unknown> = { ...defaults, ...partial };

  merged.mappings = Array.isArray(partial.mappings) ? partial.mappings : [];

  const appKey = partial.appKey;
  if (typeof appKey === 'string' && appKey.trim()) {
    merged.appKey = appKey.trim();
  } else {
    delete merged.appKey;
  }

  return merged;
}

function readConfigRaw(absPath: string): unknown {
  const text = fs.readFileSync(absPath, 'utf-8').trim();
  if (text === '') return {};
  return JSON.parse(text) as unknown;
}

/**
 * 从 JSON 文件加载并验证配置。
 * 文件不存在、为空、`{}`、不完整或 JSON 解析失败时，自动合并/写入默认 config.json 并继续启动。
 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): SyncConfig {
  return loadConfigWithMeta(configPath).config;
}

export function loadConfigWithMeta(configPath: string = DEFAULT_CONFIG_PATH): LoadConfigResult {
  const absPath = path.resolve(configPath);
  let bootstrapped = false;
  let bootstrapReason = '';
  let raw: unknown;

  if (!fs.existsSync(absPath)) {
    raw = getDefaultConfigRaw();
    bootstrapped = true;
    bootstrapReason = '配置文件不存在，已生成默认配置';
  } else {
    try {
      raw = readConfigRaw(absPath);
    } catch (e) {
      raw = getDefaultConfigRaw();
      bootstrapped = true;
      bootstrapReason = `配置文件解析失败，已重置为默认配置（${e instanceof Error ? e.message : String(e)}）`;
    }

    if (!bootstrapped) {
      if (isEmptyConfigRaw(raw)) {
        raw = getDefaultConfigRaw();
        bootstrapped = true;
        bootstrapReason = '配置文件为空，已写入默认配置';
      } else if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        raw = getDefaultConfigRaw();
        bootstrapped = true;
        bootstrapReason = '配置文件格式无效，已重置为默认配置';
      } else {
        const obj = raw as Record<string, unknown>;
        if (isIncompleteConfigRaw(obj)) {
          raw = mergeWithDefaultConfigRaw(obj);
          bootstrapped = true;
          bootstrapReason = '配置文件不完整，已合并默认配置';
        }
      }
    }
  }

  const config = validateConfig(raw, absPath);
  warnDuplicateLocalRoots(config.mappings, absPath);

  if (bootstrapped) {
    writeConfigFile(absPath, configToRaw(config));
    console.log(`[Config] ${bootstrapReason}: ${absPath}`);
  }

  return { config, bootstrapped };
}

/** 从 JSON 对象解析 SyncConfig（供中心配置 merge 等内存场景） */
export function parseSyncConfig(raw: unknown, filePath = '<memory>'): SyncConfig {
  return validateConfig(raw, filePath);
}

/**
 * centralManagerUrl 解析：
 * - 配置项缺失 → 使用默认测试环境地址（新装/升级补全后自动上报）
 * - 显式空字符串 → 关闭 sync-manage 上报
 */
function resolveCentralManagerUrl(
  obj: Record<string, unknown>,
): Pick<SyncConfig, 'centralManagerUrl'> | Record<string, never> {
  if (!('centralManagerUrl' in obj)) {
    return { centralManagerUrl: DEFAULT_CENTRAL_MANAGER_URL };
  }
  if (typeof obj.centralManagerUrl !== 'string') {
    return {};
  }
  const trimmed = obj.centralManagerUrl.trim().replace(/\/+$/, '');
  return trimmed ? { centralManagerUrl: trimmed } : {};
}

/** @deprecated 保留类型兼容；localRoot 重复不再阻断加载 */
export type ValidateConfigOptions = {
  skipDuplicateLocalRoots?: boolean;
};

export interface LocalRootDuplicateGroup {
  localRoot: string;
  mappingIds: string[];
}

/** 从 config.json 读取 mappings（不做 localRoot 唯一性校验，供管理 API 展示/修复） */
export function readMappingsFromConfigFile(configPath: string): SyncMapping[] {
  const absPath = path.resolve(configPath);
  const raw = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as Record<string, unknown>;
  const mappingsInput = Array.isArray(raw.mappings) ? raw.mappings : [];
  return mappingsInput.map((m, idx) => validateMapping(m, idx, absPath));
}

/**
 * 将指定 mapping 的 enabled 写入 config.json（原子写盘）。
 * 供管理 API 与运行时保护（localRoot 被删自动禁用）共用。
 */
export function setMappingEnabledInConfigFile(
  configPath: string,
  mappingId: string,
  enabled: boolean,
): { ok: true; changed: boolean } | { ok: false; error: string } {
  const absPath = path.resolve(configPath);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      error: `读取 config.json 失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const mappingsInput = Array.isArray(raw.mappings) ? [...raw.mappings] : [];
  const idx = mappingsInput.findIndex(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      !Array.isArray(m) &&
      (m as { mappingId?: string }).mappingId === mappingId,
  );
  if (idx === -1) {
    return { ok: false, error: `未找到 mapping "${mappingId}"` };
  }

  const entry = mappingsInput[idx];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { ok: false, error: `mapping "${mappingId}" 配置项格式无效` };
  }

  const record = entry as Record<string, unknown>;
  if (record.enabled === enabled) {
    return { ok: true, changed: false };
  }

  mappingsInput[idx] = { ...record, enabled };
  raw.mappings = mappingsInput;

  try {
    writeConfigFile(absPath, raw);
  } catch (e) {
    return {
      ok: false,
      error: `写入 config.json 失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { ok: true, changed: true };
}

export function normalizeLocalRootPath(localRoot: string): string {
  return path.resolve(localRoot);
}

/**
 * localRoot 是否位于给定前缀下（或正好等于前缀）。
 * Windows 下路径比较忽略大小写；不会把 `/foo` 误匹配成 `/foobar`。
 */
export function isLocalRootUnderPrefix(localRoot: string, pathPrefix: string): boolean {
  const root = normalizeLocalRootPath(localRoot);
  const prefix = normalizeLocalRootPath(pathPrefix);
  if (process.platform === 'win32') {
    const rootLc = root.toLowerCase();
    const prefixLc = prefix.toLowerCase();
    if (rootLc === prefixLc) return true;
    const sep = path.sep;
    return rootLc.startsWith(prefixLc.endsWith(sep) ? prefixLc : prefixLc + sep);
  }
  if (root === prefix) return true;
  const sep = path.sep;
  return root.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);
}

export function findDuplicateLocalRootGroups(mappings: SyncMapping[]): LocalRootDuplicateGroup[] {
  const byNorm = new Map<string, LocalRootDuplicateGroup>();
  for (const m of mappings) {
    const norm = normalizeLocalRootPath(m.localRoot);
    const existing = byNorm.get(norm);
    if (existing) {
      existing.mappingIds.push(m.mappingId);
    } else {
      byNorm.set(norm, { localRoot: m.localRoot, mappingIds: [m.mappingId] });
    }
  }
  return [...byNorm.values()].filter((g) => g.mappingIds.length > 1);
}

/** @deprecated 仅用于诊断；配置加载与 API 写入不再抛此错误 */
export function assertUniqueLocalRoots(mappings: SyncMapping[]): void {
  const groups = findDuplicateLocalRootGroups(mappings);
  if (groups.length === 0) return;
  const g = groups[0];
  throw new Error(
    `配置错误: localRoot "${g.localRoot}" 被多个 mapping 使用（mappingId: ${g.mappingIds.join(' 和 ')}），可能引起回环`,
  );
}

export function warnDuplicateLocalRoots(mappings: SyncMapping[], filePath = '<config>'): void {
  for (const g of findDuplicateLocalRootGroups(mappings)) {
    console.warn(
      `[Config] localRoot 冲突 (${filePath}): "${g.localRoot}" 被 ${g.mappingIds.length} 个 mapping 共用 [${g.mappingIds.join(', ')}]；` +
        '同一目录仅先出现的已启用项会参与同步，请在 Web 控制台禁用或删除多余项',
    );
  }
}

/** 同一 localRoot 下仅 config 中先出现且 enabled 的 mapping 实际参与同步 */
export function isMappingEffectiveEnabled(
  mapping: SyncMapping,
  allMappings: SyncMapping[],
): boolean {
  if (!mapping.enabled) return false;
  const norm = normalizeLocalRootPath(mapping.localRoot);
  const firstEnabled = allMappings.find(
    (m) => m.enabled && normalizeLocalRootPath(m.localRoot) === norm,
  );
  return firstEnabled?.mappingId === mapping.mappingId;
}

/** 保存时：若 localRoot 冲突且请求为启用，降级为 disabled */
export function downgradeMappingIfLocalRootConflict(
  mapping: SyncMapping,
  allMappings: SyncMapping[],
): { mapping: SyncMapping; downgraded: boolean; warning?: string } {
  if (!mapping.enabled) {
    return { mapping, downgraded: false };
  }
  const norm = normalizeLocalRootPath(mapping.localRoot);
  const conflictingEnabled = allMappings.filter(
    (m) =>
      m.mappingId !== mapping.mappingId
      && m.enabled
      && normalizeLocalRootPath(m.localRoot) === norm,
  );
  if (conflictingEnabled.length === 0) {
    return { mapping, downgraded: false };
  }
  const others = conflictingEnabled.map((m) => m.mappingId);
  return {
    mapping: { ...mapping, enabled: false },
    downgraded: true,
    warning:
      others.length > 0
        ? `localRoot 与映射 ${others.join('、')} 冲突，已自动设为禁用；请调整目录或处理冲突项后再启用`
        : 'localRoot 存在冲突，已自动设为禁用',
  };
}

export function isLocalRootDuplicateError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('被多个 mapping 使用');
}

function validateConfig(
  raw: unknown,
  filePath: string,
  options?: ValidateConfigOptions,
): SyncConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`配置文件内容必须是 JSON 对象: ${filePath}`);
  }

  const obj = raw as Record<string, unknown>;

  const serverUrl =
    typeof obj.serverUrl === 'string' && obj.serverUrl.trim()
      ? obj.serverUrl.trim()
      : DEFAULT_SERVER_URL;

  const rawAppKey = obj.appKey;
  const globalAppKey =
    typeof rawAppKey === 'string' && rawAppKey.trim() !== '' ? rawAppKey.trim() : undefined;

  const mappingsInput = Array.isArray(obj.mappings) ? obj.mappings : [];

  const syncDirection = (obj.syncDirection as string) ?? 'bidirectional';
  if (!['bidirectional', 'push', 'pull'].includes(syncDirection)) {
    throw new Error(`配置 "syncDirection" 必须是 "bidirectional" | "push" | "pull": ${filePath}`);
  }

  const mappings: SyncMapping[] = mappingsInput.map((m, idx) =>
    validateMapping(m, idx, filePath),
  );

  void options;

  return {
    serverUrl,
    ...(globalAppKey !== undefined ? { appKey: globalAppKey } : {}),
    syncDirection: syncDirection as SyncConfig['syncDirection'],
    autoSyncIntervalSec:
      typeof obj.autoSyncIntervalSec === 'number'
        ? obj.autoSyncIntervalSec
        : DEFAULT_AUTO_SYNC_INTERVAL_SEC,
    fullReconcileIntervalSec:
      typeof obj.fullReconcileIntervalSec === 'number'
        ? obj.fullReconcileIntervalSec
        : DEFAULT_FULL_RECONCILE_INTERVAL_SEC,
    stateDbPath:
      typeof obj.stateDbPath === 'string' && obj.stateDbPath.trim()
        ? obj.stateDbPath.trim()
        : DEFAULT_DB_PATH,
    maxConcurrentMappingsMode:
      obj.maxConcurrentMappingsMode === 'manual' ? 'manual' : 'auto',
    maxConcurrentMappings:
      boundedPositiveInteger(
        obj.maxConcurrentMappings,
        DEFAULT_MAX_CONCURRENT_MAPPINGS,
        MAX_CONCURRENT_MAPPINGS_LIMIT,
        'maxConcurrentMappings',
      ),
    maxRequestsPerMinute:
      boundedPositiveInteger(
        obj.maxRequestsPerMinute,
        DEFAULT_MAX_REQUESTS_PER_MINUTE,
        MAX_REQUESTS_PER_MINUTE_LIMIT,
        'maxRequestsPerMinute',
      ),
    rateLimitBurst:
      boundedPositiveInteger(
        obj.rateLimitBurst,
        DEFAULT_RATE_LIMIT_BURST,
        MAX_RATE_LIMIT_BURST,
        'rateLimitBurst',
      ),
    rateLimitCooldownSec:
      typeof obj.rateLimitCooldownSec === 'number'
        ? obj.rateLimitCooldownSec
        : RATE_LIMIT_COOLDOWN_MS / 1000,
    downloadConcurrency:
      boundedPositiveInteger(
        obj.downloadConcurrency,
        DOWNLOAD_CONCURRENCY,
        MAX_DOWNLOAD_CONCURRENCY,
        'downloadConcurrency',
      ),
    uploadConcurrency:
      boundedPositiveInteger(
        obj.uploadConcurrency,
        UPLOAD_CONCURRENCY,
        MAX_UPLOAD_CONCURRENCY,
        'uploadConcurrency',
      ),
    maxFileSizeBytes:
      boundedPositiveInteger(
        obj.maxFileSizeBytes,
        DEFAULT_MAX_FILE_SIZE_BYTES,
        MAX_FILE_SIZE_BYTES_LIMIT,
        'maxFileSizeBytes',
      ),
    massSyncProtectionEnabled:
      typeof obj.massSyncProtectionEnabled === 'boolean'
        ? obj.massSyncProtectionEnabled
        : DEFAULT_MASS_SYNC_PROTECTION_ENABLED,
    maxUploadFilesPerSync:
      boundedPositiveInteger(
        obj.maxUploadFilesPerSync,
        DEFAULT_MAX_UPLOAD_FILES_PER_SYNC,
        MAX_FILES_PER_SYNC_LIMIT,
        'maxUploadFilesPerSync',
      ),
    maxDownloadFilesPerSync:
      boundedPositiveInteger(
        obj.maxDownloadFilesPerSync,
        DEFAULT_MAX_DOWNLOAD_FILES_PER_SYNC,
        MAX_FILES_PER_SYNC_LIMIT,
        'maxDownloadFilesPerSync',
      ),
    startupJitterMaxSec:
      typeof obj.startupJitterMaxSec === 'number'
        ? obj.startupJitterMaxSec
        : STARTUP_JITTER_MAX_MS / 1000,
    managementPort:
      typeof obj.managementPort === 'number' ? obj.managementPort : DEFAULT_MANAGEMENT_PORT,
    managementHost:
      typeof obj.managementHost === 'string' && obj.managementHost.trim()
        ? obj.managementHost.trim()
        : DEFAULT_MANAGEMENT_HOST,
    watchEnabled:
      typeof obj.watchEnabled === 'boolean' ? obj.watchEnabled : DEFAULT_WATCH_ENABLED,
    pushDebounceMs:
      typeof obj.pushDebounceMs === 'number'
        ? Math.max(100, obj.pushDebounceMs)
        : DEFAULT_PUSH_DEBOUNCE_MS,
    watchUsePolling:
      typeof obj.watchUsePolling === 'boolean'
        ? obj.watchUsePolling
        : DEFAULT_WATCH_USE_POLLING,
    syncDotFiles:
      typeof obj.syncDotFiles === 'boolean' ? obj.syncDotFiles : DEFAULT_SYNC_DOT_FILES,
    ...(typeof obj.nodeId === 'string' && obj.nodeId.trim() ? { nodeId: obj.nodeId.trim() } : {}),
    ...(typeof obj.nodeAdvertiseIp === 'string' && obj.nodeAdvertiseIp.trim()
      ? { nodeAdvertiseIp: obj.nodeAdvertiseIp.trim() }
      : {}),
    ...(Array.isArray(obj.nodeExcludeInterfaces)
      ? { nodeExcludeInterfaces: (obj.nodeExcludeInterfaces as unknown[]).map(String) }
      : {}),
    ...resolveCentralManagerUrl(obj),
    ...(typeof obj.centralHeartbeatIntervalSec === 'number'
      ? { centralHeartbeatIntervalSec: obj.centralHeartbeatIntervalSec }
      : {}),
    autoUpgradeEnabled:
      typeof obj.autoUpgradeEnabled === 'boolean'
        ? obj.autoUpgradeEnabled
        : DEFAULT_AUTO_UPGRADE_ENABLED,
    ...(typeof obj.autoUpgradeScript === 'string' && obj.autoUpgradeScript.trim()
      ? { autoUpgradeScript: obj.autoUpgradeScript.trim() }
      : {}),
    ...(typeof obj.localConfigVersion === 'number' && Number.isFinite(obj.localConfigVersion)
      ? { localConfigVersion: Math.max(0, Math.floor(obj.localConfigVersion)) }
      : {}),
    mappings,
  };
}

export function validateMapping(raw: unknown, idx: number, filePath: string): SyncMapping {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`mappings[${idx}] 必须是对象: ${filePath}`);
  }

  const m = raw as Record<string, unknown>;
  const loc = `mappings[${idx}]`;

  assertString(m, 'mappingId', filePath, loc);
  assertString(m, 'localRoot', filePath, loc);

  const hasFileId =
    typeof m.remoteRootFileId === 'string' && (m.remoteRootFileId as string).trim() !== '';
  const hasFolderPath =
    typeof m.remoteRootFolderPath === 'string' && (m.remoteRootFolderPath as string).trim() !== '';
  // 两者均不填时表示同步 projectId 空间的根目录，合法。

  if (m.enabled !== undefined && typeof m.enabled !== 'boolean') {
    throw new Error(`${loc}.enabled 必须是 boolean: ${filePath}`);
  }

  const filePatterns = Array.isArray(m.filePatterns)
    ? (m.filePatterns as string[])
    : DEFAULT_FILE_PATTERNS;

  const excludePatterns = Array.isArray(m.excludePatterns)
    ? (m.excludePatterns as string[])
    : DEFAULT_EXCLUDE_PATTERNS;

  const mappingAppKey =
    typeof m.appKey === 'string' && (m.appKey as string).trim()
      ? (m.appKey as string).trim()
      : undefined;

  const validDirections = ['bidirectional', 'push', 'pull'] as const;
  const rawDir = m.syncDirection as string | undefined;
  if (rawDir !== undefined && !validDirections.includes(rawDir as (typeof validDirections)[number])) {
    throw new Error(`${loc}.syncDirection 必须是 "bidirectional" | "push" | "pull": ${filePath}`);
  }
  const mappingSyncDirection =
    rawDir && validDirections.includes(rawDir as (typeof validDirections)[number])
      ? (rawDir as 'bidirectional' | 'push' | 'pull')
      : undefined;

  const moveNameConflictStrategy = parseMoveConflictStrategy(
    m.moveNameConflictStrategy,
    filePath,
    loc,
  );
  const renameNameConflictStrategy = parseRenameConflictStrategy(
    m.renameNameConflictStrategy,
    filePath,
    loc,
  );

  if (m.enableFileIndex !== undefined && typeof m.enableFileIndex !== 'boolean') {
    throw new Error(`${loc}.enableFileIndex 必须是 boolean: ${filePath}`);
  }

  if (m.watchEnabled !== undefined && typeof m.watchEnabled !== 'boolean') {
    throw new Error(`${loc}.watchEnabled 必须是 boolean: ${filePath}`);
  }
  if (m.pushDebounceMs !== undefined && typeof m.pushDebounceMs !== 'number') {
    throw new Error(`${loc}.pushDebounceMs 必须是 number: ${filePath}`);
  }
  if (m.watchUsePolling !== undefined && typeof m.watchUsePolling !== 'boolean') {
    throw new Error(`${loc}.watchUsePolling 必须是 boolean: ${filePath}`);
  }
  if (m.syncDotFiles !== undefined && typeof m.syncDotFiles !== 'boolean') {
    throw new Error(`${loc}.syncDotFiles 必须是 boolean: ${filePath}`);
  }
  if (
    m.massSyncProtectionEnabled !== undefined &&
    typeof m.massSyncProtectionEnabled !== 'boolean'
  ) {
    throw new Error(`${loc}.massSyncProtectionEnabled 必须是 boolean: ${filePath}`);
  }

  const parseMappingLimit = (value: unknown, field: string): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${loc}.${field} 必须是正数: ${filePath}`);
    }
    return Math.min(Math.floor(value), MAX_FILES_PER_SYNC_LIMIT);
  };

  return {
    mappingId: m.mappingId as string,
    enabled: typeof m.enabled === 'boolean' ? m.enabled : true,
    localRoot: m.localRoot as string,
    appKey: mappingAppKey,
    projectId: typeof m.projectId === 'string' ? m.projectId : undefined,
    remoteRootFileId: hasFileId ? (m.remoteRootFileId as string) : undefined,
    remoteRootFolderPath: hasFolderPath ? (m.remoteRootFolderPath as string) : undefined,
    filePatterns,
    excludePatterns,
    syncDirection: mappingSyncDirection,
    moveNameConflictStrategy,
    renameNameConflictStrategy,
    enableFileIndex: typeof m.enableFileIndex === 'boolean' ? m.enableFileIndex : undefined,
    watchEnabled: typeof m.watchEnabled === 'boolean' ? m.watchEnabled : undefined,
    pushDebounceMs: typeof m.pushDebounceMs === 'number' ? m.pushDebounceMs : undefined,
    watchUsePolling: typeof m.watchUsePolling === 'boolean' ? m.watchUsePolling : undefined,
    syncDotFiles: typeof m.syncDotFiles === 'boolean' ? m.syncDotFiles : undefined,
    massSyncProtectionEnabled:
      typeof m.massSyncProtectionEnabled === 'boolean'
        ? m.massSyncProtectionEnabled
        : undefined,
    maxUploadFilesPerSync: parseMappingLimit(m.maxUploadFilesPerSync, 'maxUploadFilesPerSync'),
    maxDownloadFilesPerSync: parseMappingLimit(
      m.maxDownloadFilesPerSync,
      'maxDownloadFilesPerSync',
    ),
  };
}

function parseMoveConflictStrategy(
  raw: unknown,
  filePath: string,
  loc: string,
): 0 | 1 | 2 | 3 | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (![0, 1, 2, 3].includes(n)) {
    throw new Error(`${loc}.moveNameConflictStrategy 必须是 0|1|2|3: ${filePath}`);
  }
  return n as 0 | 1 | 2 | 3;
}

function parseRenameConflictStrategy(
  raw: unknown,
  filePath: string,
  loc: string,
): 0 | 1 | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (![0, 1].includes(n)) {
    throw new Error(`${loc}.renameNameConflictStrategy 必须是 0|1: ${filePath}`);
  }
  return n as 0 | 1;
}

/**
 * 为 POST /mappings 生成不与现有列表冲突的 mappingId。
 */
export function generateUniqueMappingId(existingIds: readonly string[]): string {
  const used = new Set(existingIds);
  for (let n = 0; n < 64; n++) {
    const id = `map-${randomBytes(8).toString('hex')}`;
    if (!used.has(id)) return id;
  }
  throw new Error('无法自动生成唯一 mappingId，请在请求体中显式指定 mappingId');
}

function assertString(
  obj: Record<string, unknown>,
  key: string,
  filePath: string,
  prefix?: string,
): void {
  const label = prefix ? `${prefix}.${key}` : key;
  if (typeof obj[key] !== 'string' || !(obj[key] as string).trim()) {
    throw new Error(`配置 "${label}" 必须是非空字符串: ${filePath}`);
  }
}

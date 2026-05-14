import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { SyncConfig, SyncMapping } from './types';
import {
  DEFAULT_DB_PATH,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_FILE_PATTERNS,
  DEFAULT_MAX_CONCURRENT_MAPPINGS,
  DEFAULT_MAX_REQUESTS_PER_MINUTE,
  DEFAULT_RATE_LIMIT_BURST,
  DOWNLOAD_CONCURRENCY,
  RATE_LIMIT_COOLDOWN_MS,
  STARTUP_JITTER_MAX_MS,
  UPLOAD_CONCURRENCY,
} from './constants';

const DEFAULT_CONFIG_PATH = './config.json';

/**
 * 从 JSON 文件加载并验证配置。
 * @param configPath 配置文件路径（默认 ./config.json）
 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): SyncConfig {
  const absPath = path.resolve(configPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`配置文件不存在: ${absPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  } catch (e) {
    throw new Error(`配置文件解析失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  return validateConfig(raw, absPath);
}

function validateConfig(raw: unknown, filePath: string): SyncConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`配置文件内容必须是 JSON 对象: ${filePath}`);
  }

  const obj = raw as Record<string, unknown>;

  // 必填字段
  assertString(obj, 'serverUrl', filePath);

  const rawAppKey = obj.appKey;
  const globalAppKey =
    typeof rawAppKey === 'string' && rawAppKey.trim() !== '' ? rawAppKey.trim() : undefined;

  if (!Array.isArray(obj.mappings)) {
    throw new Error(`配置 "mappings" 必须是数组: ${filePath}`);
  }

  const syncDirection = (obj.syncDirection as string) ?? 'bidirectional';
  if (!['bidirectional', 'push', 'pull'].includes(syncDirection)) {
    throw new Error(`配置 "syncDirection" 必须是 "bidirectional" | "push" | "pull": ${filePath}`);
  }

  const mappings: SyncMapping[] = (obj.mappings as unknown[]).map((m, idx) =>
    validateMapping(m, idx, filePath),
  );

  // 校验同一 localRoot 不映射到多个云端根
  const localRootSet = new Map<string, string>();
  for (const m of mappings) {
    const norm = path.resolve(m.localRoot);
    if (localRootSet.has(norm)) {
      throw new Error(
        `配置错误: localRoot "${m.localRoot}" 被多个 mapping 使用（mappingId: ${localRootSet.get(norm)} 和 ${m.mappingId}），可能引起回环`,
      );
    }
    localRootSet.set(norm, m.mappingId);
  }

  return {
    serverUrl: obj.serverUrl as string,
    ...(globalAppKey !== undefined ? { appKey: globalAppKey } : {}),
    syncDirection: syncDirection as SyncConfig['syncDirection'],
    autoSyncIntervalSec: typeof obj.autoSyncIntervalSec === 'number' ? obj.autoSyncIntervalSec : 60,
    stateDbPath: typeof obj.stateDbPath === 'string' ? obj.stateDbPath : DEFAULT_DB_PATH,
    maxConcurrentMappings:
      typeof obj.maxConcurrentMappings === 'number'
        ? obj.maxConcurrentMappings
        : DEFAULT_MAX_CONCURRENT_MAPPINGS,
    maxRequestsPerMinute:
      typeof obj.maxRequestsPerMinute === 'number'
        ? obj.maxRequestsPerMinute
        : DEFAULT_MAX_REQUESTS_PER_MINUTE,
    rateLimitBurst:
      typeof obj.rateLimitBurst === 'number' ? obj.rateLimitBurst : DEFAULT_RATE_LIMIT_BURST,
    rateLimitCooldownSec:
      typeof obj.rateLimitCooldownSec === 'number'
        ? obj.rateLimitCooldownSec
        : RATE_LIMIT_COOLDOWN_MS / 1000,
    downloadConcurrency:
      typeof obj.downloadConcurrency === 'number' ? obj.downloadConcurrency : DOWNLOAD_CONCURRENCY,
    uploadConcurrency:
      typeof obj.uploadConcurrency === 'number' ? obj.uploadConcurrency : UPLOAD_CONCURRENCY,
    startupJitterMaxSec:
      typeof obj.startupJitterMaxSec === 'number'
        ? obj.startupJitterMaxSec
        : STARTUP_JITTER_MAX_MS / 1000,
    managementPort: typeof obj.managementPort === 'number' ? obj.managementPort : 9090,
    managementHost: typeof obj.managementHost === 'string' ? obj.managementHost : '127.0.0.1',
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
  };
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

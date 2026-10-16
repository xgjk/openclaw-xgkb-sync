import * as fs from 'fs';
import * as path from 'path';

/** 运维侧独立配置文件名（与 config.json 同级，不随自动升级覆盖） */
export const DOWNLOAD_URL_REWRITE_FILE_NAME = 'download-url-rewrites.json';

/** 默认缓存 TTL：5 分钟；到期后才 stat/必要时重读 */
export const DOWNLOAD_URL_REWRITE_TTL_MS = 5 * 60 * 1000;

export interface DownloadUrlRewriteRule {
  /** 规范化后的 origin，如 https://new-minio-cluster.meditube.hk */
  fromOrigin: string;
  /** 规范化后的 origin，如 https://hk-al-minio.mediportal.com.cn */
  toOrigin: string;
}

export interface RewriteDownloadUrlOptions {
  /** 覆盖默认文件路径（测试或特殊部署） */
  filePath?: string;
  /** 注入当前时间（测试用） */
  now?: number;
  /** 覆盖默认 TTL（测试用） */
  ttlMs?: number;
}

interface CacheState {
  filePath: string;
  rules: DownloadUrlRewriteRule[];
  /** 文件不存在时为 null（负缓存） */
  mtimeMs: number | null;
  loadedAt: number;
}

let cache: CacheState | null = null;
/** 实际读盘次数（含 JSON 解析）；测试可观测负缓存是否生效 */
let diskReadCount = 0;

function defaultProjectRoot(): string {
  return path.resolve(__dirname, '..');
}

/** 默认路径：项目根目录下的 download-url-rewrites.json */
export function resolveDownloadUrlRewritePath(projectRoot?: string): string {
  return path.resolve(projectRoot ?? defaultProjectRoot(), DOWNLOAD_URL_REWRITE_FILE_NAME);
}

function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function parseRulesFromRaw(raw: unknown, filePath: string): DownloadUrlRewriteRule[] {
  if (!Array.isArray(raw)) {
    console.warn(`[DownloadUrlRewrite] ${filePath} 根节点必须是数组，已忽略`);
    return [];
  }

  const rules: DownloadUrlRewriteRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      console.warn(`[DownloadUrlRewrite] 第 ${i} 条规则格式无效，已跳过`);
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.from !== 'string' || typeof obj.to !== 'string') {
      console.warn(`[DownloadUrlRewrite] 第 ${i} 条规则缺少 from/to 字符串，已跳过`);
      continue;
    }
    const fromOrigin = normalizeOrigin(obj.from);
    const toOrigin = normalizeOrigin(obj.to);
    if (!fromOrigin || !toOrigin) {
      console.warn(`[DownloadUrlRewrite] 第 ${i} 条规则 from/to 不是合法 URL，已跳过`);
      continue;
    }
    if (fromOrigin === toOrigin) continue;
    rules.push({ fromOrigin, toOrigin });
  }
  return rules;
}

/** 仅在确认文件存在且 mtime 变化时调用；diskReadCount 统计 readFileSync 次数 */
function readRulesFromDisk(filePath: string): DownloadUrlRewriteRule[] {
  diskReadCount++;
  try {
    const text = fs.readFileSync(filePath, 'utf-8').trim();
    if (!text) {
      console.log(`[DownloadUrlRewrite] ${filePath} 为空，使用空规则（已缓存）`);
      return [];
    }
    const rules = parseRulesFromRaw(JSON.parse(text) as unknown, filePath);
    console.log(
      `[DownloadUrlRewrite] 已加载 ${rules.length} 条域名替换规则: ${filePath}`,
    );
    return rules;
  } catch (e) {
    console.warn(
      `[DownloadUrlRewrite] 读取失败，使用空规则（已缓存）: ${filePath} — ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}

function getRules(opts?: RewriteDownloadUrlOptions): DownloadUrlRewriteRule[] {
  const filePath = opts?.filePath ?? resolveDownloadUrlRewritePath();
  const now = opts?.now ?? Date.now();
  const ttlMs = opts?.ttlMs ?? DOWNLOAD_URL_REWRITE_TTL_MS;

  if (cache && cache.filePath === filePath && now - cache.loadedAt < ttlMs) {
    return cache.rules;
  }

  let mtimeMs: number | null = null;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    mtimeMs = null;
  }

  // TTL 到期但 mtime 未变（含仍不存在）：只刷新 loadedAt，不读内容
  if (cache && cache.filePath === filePath && cache.mtimeMs === mtimeMs) {
    cache.loadedAt = now;
    return cache.rules;
  }

  const rules = mtimeMs == null ? [] : readRulesFromDisk(filePath);
  cache = { filePath, rules, mtimeMs, loadedAt: now };

  if (mtimeMs == null) {
    console.log(
      `[DownloadUrlRewrite] 未找到配置文件，使用空规则（已缓存 ${ttlMs / 1000}s）: ${filePath}`,
    );
  }

  return cache.rules;
}

/**
 * 若配置了匹配规则，将 downloadUrl 的 origin 替换为 to；否则原样返回。
 * 规则文件经 TTL + mtime 缓存；文件缺失也会负缓存，避免每次下载读盘。
 */
export function rewriteDownloadUrl(url: string, opts?: RewriteDownloadUrlOptions): string {
  if (!url) return url;
  const rules = getRules(opts);
  if (rules.length === 0) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  for (const rule of rules) {
    if (parsed.origin === rule.fromOrigin) {
      return rule.toOrigin + parsed.pathname + parsed.search + parsed.hash;
    }
  }
  return url;
}

/** 测试用：清空内存缓存 */
export function resetDownloadUrlRewriteCache(): void {
  cache = null;
  diskReadCount = 0;
}

/** 测试用：实际读盘（含解析）次数 */
export function getDownloadUrlRewriteDiskReadCount(): number {
  return diskReadCount;
}

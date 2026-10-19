import {
  DOWNLOAD_PERMISSION_RETRY_BASE_MS,
  DOWNLOAD_RETRY_BASE_MS,
  DOWNLOAD_RETRY_MAX_MS,
  MAX_DOWNLOAD_ATTEMPTS,
  MTIME_TOLERANCE_MS,
} from './constants';
import type { FileState, RemoteFileEntry } from './types';

/** 下载失败分类：决定是否允许全文兜底、如何退避、是否计入放弃。 */
export type DownloadFailClass =
  | 'hard_block'
  | 'permission'
  | 'queue'
  | 'timeout'
  | 'size_limit'
  | 'transient'
  | 'unknown';

export interface DownloadFailureClassification {
  failClass: DownloadFailClass;
  /** 是否允许 getDownloadInfo 失败后改打 getFullFileContent */
  allowFullContentFallback: boolean;
  /** 从「高峰期排队」文案解析出的建议等待毫秒；无则 null */
  suggestedBackoffMs: number | null;
}

const QUEUE_PATTERNS = [/高峰期下载排队/, /下载排队等待/, /排队等待中/];
const QUEUE_MINUTES_PATTERN = /剩余约\s*(\d+)\s*分钟/;
const TIMEOUT_PATTERNS = [/请求超时/, /超时/, /AbortError/i, /timeout/i];
const SIZE_LIMIT_PATTERNS = [/超过安全上限/, /文件过大/];
const PERMISSION_PATTERNS = [
  /(?:HTTP|status|code|API\s+error)\s*[:=#]?\s*403\b/i,
  /forbidden/i,
  /权限不足|没有权限|无权限|无权访问|禁止访问/,
];
const HARD_BLOCK_PATTERNS = [/##HARD_BLOCK##/, /##CONFIRM_BLOCK##/];
const TRANSIENT_PATTERNS = [
  /HTTP\s+5\d\d/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /fetch failed/i,
  /network/i,
  /OSS download/i,
];

/**
 * 对 getDownloadInfo / OSS / getFullFileContent 错误文案做统一分类。
 * 排队、权限、硬拦截、超时均禁止全文兜底，避免大文件走 MinIO 抽取通道加剧压力。
 */
export function classifyDownloadFailure(message: string): DownloadFailureClassification {
  const text = String(message ?? '').trim();

  if (HARD_BLOCK_PATTERNS.some((p) => p.test(text))) {
    return {
      failClass: 'hard_block',
      allowFullContentFallback: false,
      suggestedBackoffMs: null,
    };
  }
  if (PERMISSION_PATTERNS.some((p) => p.test(text))) {
    return {
      failClass: 'permission',
      allowFullContentFallback: false,
      suggestedBackoffMs: null,
    };
  }
  if (QUEUE_PATTERNS.some((p) => p.test(text))) {
    const minutes = text.match(QUEUE_MINUTES_PATTERN);
    const parsedMs = minutes ? Number(minutes[1]) * 60_000 : null;
    return {
      failClass: 'queue',
      allowFullContentFallback: false,
      suggestedBackoffMs:
        parsedMs != null && Number.isFinite(parsedMs) && parsedMs > 0
          ? Math.min(DOWNLOAD_RETRY_MAX_MS, Math.max(DOWNLOAD_RETRY_BASE_MS, parsedMs))
          : DOWNLOAD_RETRY_BASE_MS * 2,
    };
  }
  if (SIZE_LIMIT_PATTERNS.some((p) => p.test(text))) {
    return {
      failClass: 'size_limit',
      allowFullContentFallback: false,
      suggestedBackoffMs: null,
    };
  }
  if (TIMEOUT_PATTERNS.some((p) => p.test(text))) {
    return {
      failClass: 'timeout',
      allowFullContentFallback: false,
      suggestedBackoffMs: null,
    };
  }
  if (TRANSIENT_PATTERNS.some((p) => p.test(text))) {
    return {
      failClass: 'transient',
      allowFullContentFallback: true,
      suggestedBackoffMs: null,
    };
  }
  return {
    failClass: 'unknown',
    allowFullContentFallback: true,
    suggestedBackoffMs: null,
  };
}

export function downloadRetryBackoffMs(
  failClass: DownloadFailClass,
  failCount: number,
  suggestedBackoffMs?: number | null,
): number {
  if (failClass === 'size_limit') return DOWNLOAD_RETRY_MAX_MS;
  if (suggestedBackoffMs != null && suggestedBackoffMs > 0) {
    return Math.min(DOWNLOAD_RETRY_MAX_MS, suggestedBackoffMs);
  }
  const safeCount = Math.max(1, Math.floor(failCount));
  const base =
    failClass === 'permission' || failClass === 'hard_block'
      ? DOWNLOAD_PERMISSION_RETRY_BASE_MS
      : DOWNLOAD_RETRY_BASE_MS;
  return Math.min(DOWNLOAD_RETRY_MAX_MS, base * Math.pow(2, safeCount - 1));
}

export type DownloadRetryGate = 'proceed' | 'defer' | 'abandon';

/**
 * 决策阶段：是否应对该文件发起下载。
 * - abandon：已达最大次数，对该远端版本不再自动重试
 * - defer：未到 nextRetryAt，本轮跳过以降低网络压力
 * - proceed：可以尝试
 *
 * 远端 mtime 相对记录推进时视为新版本，允许重新计数。
 */
export function gateDownloadRetry(input: {
  record?: FileState | null;
  remote: RemoteFileEntry;
  now?: number;
  maxAttempts?: number;
}): DownloadRetryGate {
  const record = input.record;
  if (!record) return 'proceed';

  const now = input.now ?? Date.now();
  const maxAttempts = input.maxAttempts ?? MAX_DOWNLOAD_ATTEMPTS;
  const failCount = record.downloadFailCount ?? 0;
  if (failCount <= 0) return 'proceed';

  const remoteMtime = input.remote.mtime ?? 0;
  const recordedRemoteMtime = record.remoteMtime ?? 0;
  if (remoteMtime > recordedRemoteMtime + MTIME_TOLERANCE_MS) {
    return 'proceed';
  }

  if (failCount >= maxAttempts) return 'abandon';

  const nextRetryAt = record.downloadNextRetryAt ?? 0;
  if (nextRetryAt > now) return 'defer';

  return 'proceed';
}

export interface DownloadFailureUpdate {
  downloadFailCount: number;
  downloadNextRetryAt: number | null;
  downloadFailClass: DownloadFailClass;
  abandoned: boolean;
}

/** 单次下载失败后更新计数与下次重试时间。 */
export function nextDownloadFailureState(input: {
  previousFailCount?: number | null;
  errorMessage: string;
  now?: number;
  maxAttempts?: number;
}): DownloadFailureUpdate {
  const classification = classifyDownloadFailure(input.errorMessage);
  const maxAttempts = input.maxAttempts ?? MAX_DOWNLOAD_ATTEMPTS;
  const now = input.now ?? Date.now();

  // 超限类一次即放弃，避免反复探测
  if (classification.failClass === 'size_limit') {
    return {
      downloadFailCount: maxAttempts,
      downloadNextRetryAt: null,
      downloadFailClass: classification.failClass,
      abandoned: true,
    };
  }

  const downloadFailCount = Math.min(maxAttempts, (input.previousFailCount ?? 0) + 1);
  const abandoned = downloadFailCount >= maxAttempts;
  const backoffMs = downloadRetryBackoffMs(
    classification.failClass,
    downloadFailCount,
    classification.suggestedBackoffMs,
  );

  return {
    downloadFailCount,
    downloadNextRetryAt: abandoned ? null : now + backoffMs,
    downloadFailClass: classification.failClass,
    abandoned,
  };
}

export function clearDownloadRetryState(): Pick<
  FileState,
  'downloadFailCount' | 'downloadNextRetryAt' | 'downloadFailClass'
> {
  return {
    downloadFailCount: 0,
    downloadNextRetryAt: null,
    downloadFailClass: null,
  };
}

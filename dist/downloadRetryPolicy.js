"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyDownloadFailure = classifyDownloadFailure;
exports.downloadRetryBackoffMs = downloadRetryBackoffMs;
exports.gateDownloadRetry = gateDownloadRetry;
exports.nextDownloadFailureState = nextDownloadFailureState;
exports.clearDownloadRetryState = clearDownloadRetryState;
const constants_1 = require("./constants");
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
function classifyDownloadFailure(message) {
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
            suggestedBackoffMs: parsedMs != null && Number.isFinite(parsedMs) && parsedMs > 0
                ? Math.min(constants_1.DOWNLOAD_RETRY_MAX_MS, Math.max(constants_1.DOWNLOAD_RETRY_BASE_MS, parsedMs))
                : constants_1.DOWNLOAD_RETRY_BASE_MS * 2,
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
function downloadRetryBackoffMs(failClass, failCount, suggestedBackoffMs) {
    if (failClass === 'size_limit')
        return constants_1.DOWNLOAD_RETRY_MAX_MS;
    if (suggestedBackoffMs != null && suggestedBackoffMs > 0) {
        return Math.min(constants_1.DOWNLOAD_RETRY_MAX_MS, suggestedBackoffMs);
    }
    const safeCount = Math.max(1, Math.floor(failCount));
    const base = failClass === 'permission' || failClass === 'hard_block'
        ? constants_1.DOWNLOAD_PERMISSION_RETRY_BASE_MS
        : constants_1.DOWNLOAD_RETRY_BASE_MS;
    return Math.min(constants_1.DOWNLOAD_RETRY_MAX_MS, base * Math.pow(2, safeCount - 1));
}
/**
 * 决策阶段：是否应对该文件发起下载。
 * - abandon：已达最大次数，对该远端版本不再自动重试
 * - defer：未到 nextRetryAt，本轮跳过以降低网络压力
 * - proceed：可以尝试
 *
 * 远端 mtime 相对记录推进时视为新版本，允许重新计数。
 */
function gateDownloadRetry(input) {
    const record = input.record;
    if (!record)
        return 'proceed';
    const now = input.now ?? Date.now();
    const maxAttempts = input.maxAttempts ?? constants_1.MAX_DOWNLOAD_ATTEMPTS;
    const failCount = record.downloadFailCount ?? 0;
    if (failCount <= 0)
        return 'proceed';
    const remoteMtime = input.remote.mtime ?? 0;
    const recordedRemoteMtime = record.remoteMtime ?? 0;
    if (remoteMtime > recordedRemoteMtime + constants_1.MTIME_TOLERANCE_MS) {
        return 'proceed';
    }
    if (failCount >= maxAttempts)
        return 'abandon';
    const nextRetryAt = record.downloadNextRetryAt ?? 0;
    if (nextRetryAt > now)
        return 'defer';
    return 'proceed';
}
/** 单次下载失败后更新计数与下次重试时间。 */
function nextDownloadFailureState(input) {
    const classification = classifyDownloadFailure(input.errorMessage);
    const maxAttempts = input.maxAttempts ?? constants_1.MAX_DOWNLOAD_ATTEMPTS;
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
    const backoffMs = downloadRetryBackoffMs(classification.failClass, downloadFailCount, classification.suggestedBackoffMs);
    return {
        downloadFailCount,
        downloadNextRetryAt: abandoned ? null : now + backoffMs,
        downloadFailClass: classification.failClass,
        abandoned,
    };
}
function clearDownloadRetryState() {
    return {
        downloadFailCount: 0,
        downloadNextRetryAt: null,
        downloadFailClass: null,
    };
}
//# sourceMappingURL=downloadRetryPolicy.js.map
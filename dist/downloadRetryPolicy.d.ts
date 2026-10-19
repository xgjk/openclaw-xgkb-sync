import type { FileState, RemoteFileEntry } from './types';
/** 下载失败分类：决定是否允许全文兜底、如何退避、是否计入放弃。 */
export type DownloadFailClass = 'hard_block' | 'permission' | 'queue' | 'timeout' | 'size_limit' | 'transient' | 'unknown';
export interface DownloadFailureClassification {
    failClass: DownloadFailClass;
    /** 是否允许 getDownloadInfo 失败后改打 getFullFileContent */
    allowFullContentFallback: boolean;
    /** 从「高峰期排队」文案解析出的建议等待毫秒；无则 null */
    suggestedBackoffMs: number | null;
}
/**
 * 对 getDownloadInfo / OSS / getFullFileContent 错误文案做统一分类。
 * 排队、权限、硬拦截、超时均禁止全文兜底，避免大文件走 MinIO 抽取通道加剧压力。
 */
export declare function classifyDownloadFailure(message: string): DownloadFailureClassification;
export declare function downloadRetryBackoffMs(failClass: DownloadFailClass, failCount: number, suggestedBackoffMs?: number | null): number;
export type DownloadRetryGate = 'proceed' | 'defer' | 'abandon';
/**
 * 决策阶段：是否应对该文件发起下载。
 * - abandon：已达最大次数，对该远端版本不再自动重试
 * - defer：未到 nextRetryAt，本轮跳过以降低网络压力
 * - proceed：可以尝试
 *
 * 远端 mtime 相对记录推进时视为新版本，允许重新计数。
 */
export declare function gateDownloadRetry(input: {
    record?: FileState | null;
    remote: RemoteFileEntry;
    now?: number;
    maxAttempts?: number;
}): DownloadRetryGate;
export interface DownloadFailureUpdate {
    downloadFailCount: number;
    downloadNextRetryAt: number | null;
    downloadFailClass: DownloadFailClass;
    abandoned: boolean;
}
/** 单次下载失败后更新计数与下次重试时间。 */
export declare function nextDownloadFailureState(input: {
    previousFailCount?: number | null;
    errorMessage: string;
    now?: number;
    maxAttempts?: number;
}): DownloadFailureUpdate;
export declare function clearDownloadRetryState(): Pick<FileState, 'downloadFailCount' | 'downloadNextRetryAt' | 'downloadFailClass'>;
//# sourceMappingURL=downloadRetryPolicy.d.ts.map
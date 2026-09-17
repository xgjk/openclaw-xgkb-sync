import type { SyncOp } from './types';
export type PermanentSyncFailureCategory = 'authentication' | 'permission' | 'validation';
export interface PermanentSyncFailure {
    category: PermanentSyncFailureCategory;
    message: string;
}
/**
 * 只识别明确不会靠立即重试恢复的远端拒绝。
 * 404、文件不存在、冲突等仍按普通文件错误处理，避免误熔断整个 mapping。
 */
export declare function classifyPermanentSyncFailure(message: string): PermanentSyncFailure | null;
export declare function permanentCircuitDelayMs(failureLevel: number, baseMs: number, maxMs: number): number;
/** 只有明确发生在远端写操作上的权限拒绝才允许安全降级为只读。 */
export declare function isRemoteWritePermissionFailure(failure: PermanentSyncFailure | null | undefined, op?: SyncOp | null): boolean;
/**
 * 兼容升级前没有记录 op 的熔断状态。只有包含明确写 API/操作名的权限错误才迁移，
 * 避免把读取或初始化权限错误错误地降级成可继续拉取。
 */
export declare function isLegacyRemoteWritePermissionReason(message: string): boolean;
//# sourceMappingURL=syncErrorPolicy.d.ts.map
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
//# sourceMappingURL=syncErrorPolicy.d.ts.map
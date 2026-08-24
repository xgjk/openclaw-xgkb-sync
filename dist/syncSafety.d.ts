import type { SyncPlan } from './types';
export interface MassSyncProtectionInput {
    enabled: boolean;
    uploadPlans: SyncPlan[];
    downloadPlans: SyncPlan[];
    maxUploads: number;
    maxDownloads: number;
    localFileCount: number;
    remoteFileCount: number;
    knownFileCount: number;
}
export interface MassSyncProtectionTrip {
    uploadCount: number;
    downloadCount: number;
    maxUploads: number;
    maxDownloads: number;
    reason: string;
    samplePaths: string[];
}
/**
 * 在任何批量上传/下载发生前执行的纯判断。
 * 阈值表示“允许的最大数量”，因此只有严格超过时才熔断。
 */
export declare function evaluateMassSyncProtection(input: MassSyncProtectionInput): MassSyncProtectionTrip | null;
export declare class MassSyncProtectionError extends Error {
    readonly trip: MassSyncProtectionTrip;
    constructor(trip: MassSyncProtectionTrip);
}
export declare function isMassSyncProtectionError(value: unknown): value is MassSyncProtectionError;
//# sourceMappingURL=syncSafety.d.ts.map
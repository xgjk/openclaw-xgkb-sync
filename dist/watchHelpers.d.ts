import { SyncConfig, SyncMapping, SyncTriggerReason } from './types';
export declare function needsPush(mapping: SyncMapping, globalDirection: SyncConfig['syncDirection']): boolean;
export declare function needsPull(mapping: SyncMapping, globalDirection: SyncConfig['syncDirection']): boolean;
/** mapping 实际生效的同步方向（未单独配置时继承全局） */
export declare function resolveMappingSyncDirection(mapping: SyncMapping, globalDirection: SyncConfig['syncDirection']): SyncConfig['syncDirection'];
export declare function resolveWatchEnabled(mapping: SyncMapping, config: SyncConfig): boolean;
export declare function resolvePushDebounceMs(mapping: SyncMapping, config: SyncConfig): number;
export declare function resolveWatchUsePolling(mapping: SyncMapping, config: SyncConfig): boolean;
export declare function formatSyncTriggerReason(reason: SyncTriggerReason): string;
//# sourceMappingURL=watchHelpers.d.ts.map
import { SyncConfig } from './types';
export interface MergeCentralConfigResult {
    config: SyncConfig;
    /** 身份字段发生变化的 mappingId，需 resetMappingState */
    identityChangedMappingIds: string[];
}
/**
 * 将 sync-manage 下发的 config patch 合并进本地配置（不整文件覆盖）。
 * 白名单由中心维护；节点对 patch 中出现的字段做 merge。
 */
export declare function mergeCentralConfigPatch(local: SyncConfig, patch: Record<string, unknown>, configVersion: number): MergeCentralConfigResult;
export interface ApplyCentralConfigOptions {
    configPath: string;
    local: SyncConfig;
    patch: Record<string, unknown>;
    configVersion: number;
    resetMappingState: (mappingId: string) => void;
}
/** 合并、持久化，并返回合并后的配置（不触发 reload，由调用方负责） */
export declare function applyCentralConfigPatch(opts: ApplyCentralConfigOptions): SyncConfig;
/** 心跳上报用的 reportedConfig（完整 config.json 内容，含 appKey 明文） */
export declare function buildReportedConfig(config: SyncConfig): Record<string, unknown>;
//# sourceMappingURL=centralConfigMerge.d.ts.map
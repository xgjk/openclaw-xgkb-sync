import { SyncConfig, SyncMapping } from './types';
export type LoadConfigResult = {
    config: SyncConfig;
    /** 本次是否新建或回填/合并了 config.json */
    bootstrapped: boolean;
};
/**
 * 默认 config.json 内容（可序列化对象，不含 appKey）。
 * 服务可在无 mapping、无密钥时启动，通过 Web 控制台或管理 API 后续补全。
 */
export declare function getDefaultConfigRaw(): Record<string, unknown>;
/** 将内存中的 SyncConfig 转为可写入 config.json 的对象（省略 undefined 字段） */
export declare function configToRaw(config: SyncConfig): Record<string, unknown>;
/** 原子写入 config.json */
export declare function writeConfigFile(configPath: string, raw: Record<string, unknown>): void;
/**
 * 从 JSON 文件加载并验证配置。
 * 文件不存在、为空、`{}`、不完整或 JSON 解析失败时，自动合并/写入默认 config.json 并继续启动。
 */
export declare function loadConfig(configPath?: string): SyncConfig;
export declare function loadConfigWithMeta(configPath?: string): LoadConfigResult;
/** 从 JSON 对象解析 SyncConfig（供中心配置 merge 等内存场景） */
export declare function parseSyncConfig(raw: unknown, filePath?: string): SyncConfig;
/** @deprecated 保留类型兼容；localRoot 重复不再阻断加载 */
export type ValidateConfigOptions = {
    skipDuplicateLocalRoots?: boolean;
};
export interface LocalRootDuplicateGroup {
    localRoot: string;
    mappingIds: string[];
}
/** 从 config.json 读取 mappings（不做 localRoot 唯一性校验，供管理 API 展示/修复） */
export declare function readMappingsFromConfigFile(configPath: string): SyncMapping[];
/**
 * 将指定 mapping 的 enabled 写入 config.json（原子写盘）。
 * 供管理 API 与运行时保护（localRoot 被删自动禁用）共用。
 */
export declare function setMappingEnabledInConfigFile(configPath: string, mappingId: string, enabled: boolean): {
    ok: true;
    changed: boolean;
} | {
    ok: false;
    error: string;
};
export declare function normalizeLocalRootPath(localRoot: string): string;
export declare function findDuplicateLocalRootGroups(mappings: SyncMapping[]): LocalRootDuplicateGroup[];
/** @deprecated 仅用于诊断；配置加载与 API 写入不再抛此错误 */
export declare function assertUniqueLocalRoots(mappings: SyncMapping[]): void;
export declare function warnDuplicateLocalRoots(mappings: SyncMapping[], filePath?: string): void;
/** 同一 localRoot 下仅 config 中先出现且 enabled 的 mapping 实际参与同步 */
export declare function isMappingEffectiveEnabled(mapping: SyncMapping, allMappings: SyncMapping[]): boolean;
/** 保存时：若 localRoot 冲突且请求为启用，降级为 disabled */
export declare function downgradeMappingIfLocalRootConflict(mapping: SyncMapping, allMappings: SyncMapping[]): {
    mapping: SyncMapping;
    downgraded: boolean;
    warning?: string;
};
export declare function isLocalRootDuplicateError(err: unknown): boolean;
export declare function validateMapping(raw: unknown, idx: number, filePath: string): SyncMapping;
/**
 * 为 POST /mappings 生成不与现有列表冲突的 mappingId。
 */
export declare function generateUniqueMappingId(existingIds: readonly string[]): string;
//# sourceMappingURL=config.d.ts.map
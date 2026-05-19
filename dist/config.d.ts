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
export declare function validateMapping(raw: unknown, idx: number, filePath: string): SyncMapping;
/**
 * 为 POST /mappings 生成不与现有列表冲突的 mappingId。
 */
export declare function generateUniqueMappingId(existingIds: readonly string[]): string;
//# sourceMappingURL=config.d.ts.map
import { SyncConfig, SyncMapping } from './types';
/**
 * 从 JSON 文件加载并验证配置。
 * @param configPath 配置文件路径（默认 ./config.json）
 */
export declare function loadConfig(configPath?: string): SyncConfig;
export declare function validateMapping(raw: unknown, idx: number, filePath: string): SyncMapping;
/**
 * 为 POST /mappings 生成不与现有列表冲突的 mappingId。
 */
export declare function generateUniqueMappingId(existingIds: readonly string[]): string;
//# sourceMappingURL=config.d.ts.map
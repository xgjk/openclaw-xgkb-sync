import type { SyncConfig, SyncMapping } from './types';
/** 本地 walk / watch / 远端过滤共用的同步范围选项 */
export interface SyncScopeOptions {
    filePatterns: string[];
    excludePatterns: string[];
    /**
     * false（默认）：任意路径段以 `.` 开头的文件/目录不参与同步（在 excludePatterns 之前生效）。
     * true：点路径与普通路径同等对待，仅由 filePatterns / excludePatterns 过滤。
     */
    syncDotFiles: boolean;
}
/** 解析 mapping 级 + 全局级 syncDotFiles 与 glob 默认值 */
export declare function resolveSyncScopeOptions(mapping: Pick<SyncMapping, 'filePatterns' | 'excludePatterns' | 'syncDotFiles'>, globalConfig?: Pick<SyncConfig, 'syncDotFiles'>): SyncScopeOptions;
/** 相对路径是否包含以 `.` 开头的路径段（如 `notes/.env`、`/.git/config`） */
export declare function pathHasDotSegment(relPath: string): boolean;
/** readdir 阶段：是否因点文件名/目录名跳过（未进入路径拼接） */
export declare function shouldSkipDotEntryName(name: string, syncDotFiles: boolean): boolean;
/**
 * 判断相对路径是否在同步范围内。
 * - 目录：仅检查点路径规则 + excludePatterns（不要求匹配 filePatterns）
 * - 文件：点路径规则 + excludePatterns + filePatterns
 */
export declare function isInSyncScope(relPath: string, scope: SyncScopeOptions, kind: 'file' | 'directory'): boolean;
/** 远端 list 结果是否与本地 walk 使用相同范围规则 */
export declare function isRemotePathInSyncScope(relPath: string, scope: SyncScopeOptions): boolean;
//# sourceMappingURL=pathSyncScope.d.ts.map
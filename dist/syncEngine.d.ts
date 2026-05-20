import { LocalFsAdapter } from './localFs';
import { RemoteFsAdapter } from './remoteFs';
import { SyncStateDb } from './syncStateDb';
import { SyncMapping, SyncStats } from './types';
type ProgressCallback = (msg: string) => void;
/**
 * 核心同步引擎（OpenClaw 版）
 * 与 Obsidian 版的主要差异：
 * - 使用 mappingId 隔离多条映射规则的状态
 * - 状态库操作基于 SQLite（SyncStateDb）
 * - 本地/远端文件操作基于 LocalFsAdapter / RemoteFsAdapter
 */
export declare class SyncEngine {
    private readonly localFs;
    private readonly remoteFs;
    private readonly db;
    private readonly mapping;
    private stats;
    private progress;
    private readonly filePatterns;
    private readonly excludePatterns;
    private readonly downloadConcurrency;
    private readonly uploadConcurrency;
    constructor(localFs: LocalFsAdapter, remoteFs: RemoteFsAdapter, db: SyncStateDb, mapping: SyncMapping, opts?: {
        downloadConcurrency?: number;
        uploadConcurrency?: number;
    });
    private delay;
    /** 判断路径是否应纳入同步范围 */
    private matchesSync;
    private emptyStats;
    /**
     * 执行一轮同步（增量优先，降级全量）。
     * @param onProgress 进度回调
     * @param lastSyncSince 上次成功同步的水位时间戳（毫秒）；undefined = 首次全量
     */
    runSync(onProgress?: ProgressCallback, lastSyncSince?: number, opts?: {
        forceFullScan?: boolean;
        forceFullScanReason?: string;
    }): Promise<SyncStats>;
    private pruneRemoteEmptyDirectories;
    /**
     * 构建远端文件 Map，优先走增量路径，遇到无法解析的新目录降级全量。
     */
    private buildRemoteMap;
    /**
     * 增量路径：listChanges + batchGetMeta。
     * 若遇到无法解析路径的新增文件，返回 null 触发全量降级。
     */
    private tryIncrementalRemoteMap;
    /** 全量扫描（listDescendantFiles 分页） */
    private fullRemoteMap;
    /**
     * 知识库允许「文件节点」下再挂文件；本地不能把同名路径既当文件又当目录。
     * 简单策略：保留祖先路径对应的文件，移除其下所有更深的路径条目。
     */
    private removePathsUnderFileNodes;
    private decide;
    /**
     * 按 concurrency 分批并发执行计划列表，批间插入 EXECUTE_BATCH_PAUSE_MS 的间隔。
     * 真正的请求限速由 KbApiClient 内置的 RateLimiter 负责，这里的 pause 只是平滑突发。
     */
    private executePlansInQueue;
    private executePlan;
    private doUploadNew;
    private doUploadUpdate;
    private doDownloadNew;
    private doDownloadUpdate;
    private doDeleteLocal;
    private doDeleteRemote;
    /** 拉取单个文件内容，由 KbApiClient 内置限速器控制请求速率 */
    private fetchContent;
}
export {};
//# sourceMappingURL=syncEngine.d.ts.map
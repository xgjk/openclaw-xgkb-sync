import * as fs from 'fs';
import { type SyncScopeOptions } from './pathSyncScope';
export interface FileWatcherOptions {
    mappingId: string;
    localRoot: string;
    scope: SyncScopeOptions;
    debounceMs: number;
    usePolling: boolean;
    onBatchReady: (pathCount: number) => void;
}
/**
 * 多 mapping 共用的底层 chokidar 实例。
 *
 * chokidar 的每个 FSWatcher 都会维护一套完整的目录/文件索引；将多个 root 放进同一实例
 * 可自动去重父子/重叠目录，同时仍由 FileWatcher 保留 mapping 级 debounce、pause、ignore 语义。
 * polling 与非 polling 的底层机制不同，由 Scheduler 分成最多两个 backend。
 */
export declare class SharedFileWatcherBackend {
    private readonly usePolling;
    private readonly registrations;
    private watcher;
    private readyPromise;
    private resolveReady;
    constructor(usePolling: boolean);
    register(registration: FileWatcher): void;
    unregister(mappingId: string): void;
    start(): void;
    stop(): Promise<void>;
    isActive(): boolean;
    /** 供启动编排和集成测试等待初次索引完成，避免漏掉 ready 前的文件事件。 */
    waitUntilReady(): Promise<void>;
    getWatchedDirectoryCount(): number;
}
/**
 * mapping 级 chokidar 封装：debounce 合并变更，sync 期间 pause，pull 写入 echo 过滤。
 * 硬排除 `.openclaw-sync-map.json`（方案一索引 consume 写入，避免误触发 push）。
 */
export declare class FileWatcher {
    private readonly sharedBackend?;
    private readonly opts;
    private readonly ignoreSet;
    private watcher;
    private pendingPaths;
    private debounceTimer;
    private ignoreTailTimer;
    private paused;
    private started;
    constructor(opts: FileWatcherOptions, sharedBackend?: SharedFileWatcherBackend | undefined);
    getMappingId(): string;
    getResolvedRoot(): string;
    start(): void;
    stop(): Promise<void>;
    /** sync 开始前暂停，丢弃期间所有 FS 事件 */
    pause(): void;
    /**
     * sync 结束后恢复；将 pull 写入路径加入 ignoreSet 一段时间，防止 resume 后 echo push。
     */
    resumeAfterSync(pullWrittenPaths?: Iterable<string>): void;
    addIgnore(paths: Iterable<string>): void;
    clearIgnore(): void;
    isActive(): boolean;
    handleSharedFsEvent(event: string, absPath: string): void;
    /** backend 的 ignored 回调：不属于本 mapping 时视为 ignore；属于时应用 mapping scope。 */
    shouldIgnoreSharedTarget(absPath: string, stats?: fs.Stats): boolean;
    private onFsEvent;
    private scheduleDebounce;
    private clearDebounce;
    private toRelativePath;
    /** 与 SyncEngine.matchesSync 一致：仅纳入同步范围的文件路径 */
    private matchesSyncScope;
    /**
     * chokidar ignored：索引文件、可选点路径规则、exclude 目录。
     * 勿 ignore 同步根（rel===''），否则 Windows 上可能收不到任何子路径事件。
     */
    private shouldIgnoreWatchTarget;
}
//# sourceMappingURL=fileWatcher.d.ts.map
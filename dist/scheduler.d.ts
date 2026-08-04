import { SyncConfig, MappingSyncRunResult, SyncTriggerReason } from './types';
export interface SyncSchedulerOptions {
    onMappingSyncFinished?: (result: MappingSyncRunResult) => void;
    /** localRoot 被删且曾有同步历史：写 config 禁用并触发热重载 */
    onMissingLocalRootDisable?: (mappingId: string, detail: string) => Promise<void>;
}
export declare function resolveMaxConcurrentMappings(config: SyncConfig): number;
/**
 * 多 Mapping 同步调度器
 * - 同一 mappingId 严格串行（防重入）
 * - 不同 mappingId 可受控并发（maxConcurrentMappings）
 * - 定时触发 + 手动触发双路径
 */
export declare class SyncScheduler {
    /** 每个 scheduler 实例唯一 ID，延迟任务携带此 ID，防止旧实例回调在 stop 后仍执行 */
    private readonly instanceId;
    private readonly config;
    private readonly db;
    /** 按 appKey 分组的限速器，每个 appKey 独享自己的令牌桶 */
    private readonly limiters;
    private readonly runStates;
    private readonly watchers;
    private readonly watcherBackends;
    private timers;
    /** triggerAll 错峰、启动抖动、pendingSync 等延迟任务 */
    private readonly pendingTimers;
    private activeSyncCount;
    /** 全局同时进行中的 mapping 同步数（真·运行上限，保护事件循环与 /health） */
    private globalRunningSyncs;
    private readonly maxGlobalRunningSyncs;
    private readonly syncDrainWaiters;
    private running;
    private dbClosed;
    private readonly onMappingSyncFinished?;
    private readonly onMissingLocalRootDisable?;
    /** localRoot 缺失后即时挂起，阻止 timer/watch 继续触发（热重载前） */
    private readonly suspendedMappingIds;
    private readonly missingRootDisableInFlight;
    private readonly circuitBreakers;
    constructor(config: SyncConfig, opts?: SyncSchedulerOptions);
    /**
     * 按 appKey 获取或创建对应的限速器。
     * 同一 appKey 的所有请求共享一个令牌桶，不同 appKey 互不干扰。
     */
    private getLimiter;
    /** 启动调度器：注册定时器，并立即触发一轮全量对账 */
    start(): void;
    /**
     * 停止调度器：取消未执行的延迟任务，等待进行中的 sync 结束，再关闭 DB。
     * @returns true 表示已安全停止并关闭 DB；false 表示仍有同步未完成（未关 DB，避免 Database already closed）
     */
    stop(): Promise<boolean>;
    private scheduleDelayed;
    private clearPendingTimers;
    private waitForActiveSyncs;
    private notifySyncDrain;
    /** 全局并发空出后，唤醒一条 pending 的 mapping */
    private drainOnePendingSync;
    /** 供探针判断负载：全局并行同步数 / 上限 */
    getGlobalSyncPressure(): {
        running: number;
        max: number;
    };
    getWatcherPressure(): {
        mappings: number;
        backends: number;
        watchedDirectories: number;
        watchedRoots: number;
        droppedRoots: number;
        modes: Record<string, number>;
    };
    getCircuitBreakerPressure(): {
        open: number;
        total: number;
    };
    /** 无进行中的 mapping 同步（供自动升级等场景） */
    isSyncIdle(): boolean;
    private startWatchers;
    private stopWatchers;
    /** 手动触发指定 mapping 同步 */
    triggerMapping(mappingId: string): void;
    /** 触发所有已启用 mapping */
    private triggerAll;
    private scheduleMapping;
    private runMappingSync;
    /**
     * localRoot 从有到无：即时挂起（停 watch、清排队），随后写 config 禁用 mapping。
     */
    private suspendMappingForMissingLocalRoot;
    private disableMappingForMissingLocalRoot;
    private doSync;
    private shouldSkipForCircuit;
    private tripCircuit;
    private clearCircuit;
    /** 获取当前生效的配置（供 ManagementApi 读取） */
    getConfig(): SyncConfig;
    private shouldForceFullScan;
    /**
     * 完全重置指定 mapping 的同步状态（文件记录 + 水位 + 远端 ID 缓存）。
     * 修改身份字段（localRoot / remoteRootFolderPath / projectId / appKey）后调用，
     * 确保下次同步以全量对账模式重建正确基准，而非用旧状态做错误决策。
     */
    resetMappingState(mappingId: string): void;
    /** 获取所有 mapping 的当前状态摘要 */
    getStatus(): Record<string, {
        isSyncing: boolean;
        pendingSync: boolean;
        syncSuspended: boolean;
        lastTriggerReason?: SyncTriggerReason;
        lastWatchTriggerAt?: number;
        watchActive: boolean;
        circuitOpen: boolean;
        circuitUntil?: number;
        circuitReason?: string;
        lastState: unknown;
    }>;
}
//# sourceMappingURL=scheduler.d.ts.map
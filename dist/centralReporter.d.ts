import { SyncScheduler } from './scheduler';
import { MappingSyncRunResult, SyncConfig } from './types';
export interface CentralMappingStatPayload {
    mappingId: string;
    /** 实际生效的同步方向（含继承全局） */
    syncDirection: SyncConfig['syncDirection'];
    lastSyncAt?: number | null;
    lastTriggerReason?: string | null;
    uploaded?: number;
    downloaded?: number;
    deleted?: number;
    failed?: number;
    errors?: string[];
}
export interface HeartbeatResponseData {
    configVersion?: number;
    latestAppVersion?: string;
    config?: Record<string, unknown> | null;
}
export interface CentralReporterOptions {
    getNodeIdentity: () => {
        nodeId: string;
        advertiseIp: string;
    };
    configPath: string;
    projectRoot: string;
    appVersion: string;
    getConfig: () => SyncConfig;
    getScheduler: () => SyncScheduler;
    getEventLoopLagMs: () => number;
}
/** 是否启用自动升级（默认开启，仅显式 false 关闭） */
export declare function isAutoUpgradeEnabled(config: SyncConfig): boolean;
export declare class CentralReporter {
    private readonly opts;
    private timer;
    private heartbeatInFlight;
    private stopped;
    /** 同一 mapping 的待发送日志只保留最新一条，避免中心停服时无限堆积。 */
    private readonly pendingExecutionLogs;
    private executionLogsInFlight;
    private readonly activeControllers;
    private droppedExecutionLogs;
    private consecutiveExecutionFailures;
    private executionPauseUntil;
    private executionDrainTimer;
    /** stop/restart 后，旧异步回调不得再修改新一代 reporter 状态。 */
    private lifecycleGeneration;
    private loggedIgnoredCentralConfig;
    private lastAnnouncedLatestVersion;
    constructor(opts: CentralReporterOptions);
    /** 资源诊断/测试：中心停服时可观察有界队列是否生效。 */
    getExecutionLogPressure(): {
        inFlight: number;
        pending: number;
        dropped: number;
    };
    start(): void;
    stop(): void;
    /** 配置变更后重启心跳定时器（如 Web 保存 centralManagerUrl） */
    restart(): void;
    /** mapping 同步结束后上报 execution-log */
    reportExecutionLog(result: MappingSyncRunResult): void;
    private drainExecutionLogs;
    private sendHeartbeat;
    private buildMappingStats;
    private postJson;
}
/** 项目根目录（含 package.json） */
export declare function resolveProjectRoot(): string;
//# sourceMappingURL=centralReporter.d.ts.map
import { SyncScheduler } from './scheduler';
import { MappingSyncRunResult } from './types';
import { SyncConfig } from './types';
export interface CentralMappingStatPayload {
    mappingId: string;
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
    constructor(opts: CentralReporterOptions);
    start(): void;
    stop(): void;
    /** 配置变更后重启心跳定时器（如 Web 保存 centralManagerUrl） */
    restart(): void;
    /** mapping 同步结束后上报 execution-log */
    reportExecutionLog(result: MappingSyncRunResult): void;
    private sendHeartbeat;
    private buildMappingStats;
    private postJson;
}
/** 项目根目录（含 package.json） */
export declare function resolveProjectRoot(): string;
//# sourceMappingURL=centralReporter.d.ts.map
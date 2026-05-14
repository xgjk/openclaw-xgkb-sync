import { SyncScheduler } from './scheduler';
import { SyncConfig } from './types';
export type ReloadResult = {
    ok: true;
    config: SyncConfig;
} | {
    ok: false;
    error: string;
};
export interface ManagementApiOptions {
    port: number;
    host: string;
    /** config.json 的绝对路径，供 mapping CRUD 接口读写 */
    configPath: string;
    /** 获取当前 scheduler 实例（reload 后引用会变） */
    getScheduler: () => SyncScheduler;
    /** 热重载回调：重新读取配置文件并重建 scheduler，返回新配置或错误 */
    onReload: () => ReloadResult;
}
/**
 * HTTP 管理 API 服务
 *
 * 路由：
 *   GET  /health              存活探针，返回版本、uptime、mapping 概况
 *   GET  /status              详细状态，含所有 mapping 的同步情况
 *   POST /sync/:mappingId     手动触发指定 mapping 同步
 *   POST /sync                手动触发所有 mapping 同步
 *   POST /reload              热重载配置文件（无需重启进程）
 */
export declare class ManagementApi {
    private readonly opts;
    private readonly startedAt;
    private server;
    constructor(opts: ManagementApiOptions);
    start(): void;
    stop(): void;
    private handle;
    private handleHealth;
    private handleStatus;
    private handleReload;
    private handleSyncAll;
    private handleSyncOne;
    private handleListMappings;
    private handleCreateMapping;
    private handleUpdateMapping;
    private handleDeleteMapping;
    /**
     * 原子修改 config.json 中的 mappings 数组。
     * 先写临时文件再重命名，防止写入中断导致配置损坏。
     */
    private modifyConfigMappings;
    /** 解析 HTTP 请求体为 JSON 对象 */
    private readBody;
    /** 隐藏 appKey 敏感字段的 mapping 摘要 */
    private mappingSummary;
    private sendJson;
}
//# sourceMappingURL=managementApi.d.ts.map
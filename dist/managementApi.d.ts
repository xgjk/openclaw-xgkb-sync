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
 * 路由速览见类内 `start()` 日志。完整契约见仓库 **docs/MANAGEMENT_API.md**（给 AI / 自动化）；appKey 保存规则见 **src/managementApiCredentials.ts**。
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
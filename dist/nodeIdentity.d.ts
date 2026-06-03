export declare class NodeIdentityError extends Error {
    constructor(message: string);
}
export interface ResolveAdvertiseIpOptions {
    /** 显式指定对外宣告 IP，优先级最高 */
    advertiseIp?: string;
    /** 额外排除的网卡名（正则字符串或字面量，不区分大小写） */
    excludeInterfaces?: string[];
}
export interface BuildNodeIdOptions extends ResolveAdvertiseIpOptions {
    /** 完整覆盖 nodeId（如运维手工登记），不再拼接 IP:端口 */
    nodeId?: string;
    managementPort: number;
}
/**
 * 从本机网卡中选取「最能代表机器内网身份」的 IPv4。
 * 禁止返回 127.0.0.1；无可用地址时抛错，要求配置 nodeAdvertiseIp。
 */
export declare function resolveAdvertiseIpv4(opts?: ResolveAdvertiseIpOptions): string;
/**
 * 构建节点唯一 ID：`{内网IP}:{管理端口}`。
 * 若配置 nodeId 则原样使用（运维兜底）。
 */
export declare function buildNodeId(opts: BuildNodeIdOptions): string;
export type NodeIdentityInfo = {
    nodeId: string;
    advertiseIp: string;
    managementPort: number;
    source: 'nodeId' | 'nodeAdvertiseIp' | 'auto';
};
/** 解析结果摘要，供心跳 /health 上报 */
export declare function describeNodeIdentity(opts: BuildNodeIdOptions): NodeIdentityInfo;
//# sourceMappingURL=nodeIdentity.d.ts.map
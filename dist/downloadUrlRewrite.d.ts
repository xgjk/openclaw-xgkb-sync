/** 运维侧独立配置文件名（与 config.json 同级，不随自动升级覆盖） */
export declare const DOWNLOAD_URL_REWRITE_FILE_NAME = "download-url-rewrites.json";
/** 默认缓存 TTL：5 分钟；到期后才 stat/必要时重读 */
export declare const DOWNLOAD_URL_REWRITE_TTL_MS: number;
export interface DownloadUrlRewriteRule {
    /** 规范化后的 origin，如 https://new-minio-cluster.meditube.hk */
    fromOrigin: string;
    /** 规范化后的 origin，如 https://hk-al-minio.mediportal.com.cn */
    toOrigin: string;
}
export interface RewriteDownloadUrlOptions {
    /** 覆盖默认文件路径（测试或特殊部署） */
    filePath?: string;
    /** 注入当前时间（测试用） */
    now?: number;
    /** 覆盖默认 TTL（测试用） */
    ttlMs?: number;
}
/** 默认路径：项目根目录下的 download-url-rewrites.json */
export declare function resolveDownloadUrlRewritePath(projectRoot?: string): string;
/**
 * 若配置了匹配规则，将 downloadUrl 的 origin 替换为 to；否则原样返回。
 * 规则文件经 TTL + mtime 缓存；文件缺失也会负缓存，避免每次下载读盘。
 */
export declare function rewriteDownloadUrl(url: string, opts?: RewriteDownloadUrlOptions): string;
/** 测试用：清空内存缓存 */
export declare function resetDownloadUrlRewriteCache(): void;
/** 测试用：实际读盘（含解析）次数 */
export declare function getDownloadUrlRewriteDiskReadCount(): number;
//# sourceMappingURL=downloadUrlRewrite.d.ts.map
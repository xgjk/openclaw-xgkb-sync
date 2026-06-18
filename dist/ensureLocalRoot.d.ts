/**
 * 确保 mapping 的 localRoot 目录在磁盘上存在（recursive mkdir）。
 * 新建 mapping 或热重载启动 watcher 前调用，避免目录尚未创建导致 chokidar 跳过。
 */
export declare function ensureMappingLocalRoot(localRoot: string): {
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
};
//# sourceMappingURL=ensureLocalRoot.d.ts.map
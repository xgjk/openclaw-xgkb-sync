/**
 * 将 console.log / warn / error 同时追加写入指定文件（UTF-8，带时间戳）。
 * 用于服务端落盘查问题，不替代 journald 等外部采集。
 */
export declare function installConsoleTee(absLogPath: string): void;
//# sourceMappingURL=consoleTee.d.ts.map
export interface ConsoleTeeOptions {
    /** 日志目录；与 logFile 二选一 */
    logDir?: string;
    /**
     * 显式日志路径（兼容 --log-file）。
     * 使用其所在目录，文件名（去 .log）作为 baseName。
     */
    logFile?: string;
    baseName?: string;
    maxFileBytes?: number;
}
/**
 * 将 console.log / warn / error 同时追加写入日志文件（UTF-8，带时间戳）。
 * 按自然日切割；单日单文件超过 maxFileBytes 时递增段号（.1、.2…）。
 */
export declare function installConsoleTee(opts: ConsoleTeeOptions | string): void;
/** @deprecated 使用 installConsoleTee({ logFile }) */
export declare function installConsoleTeeLegacy(absLogPath: string): void;
//# sourceMappingURL=consoleTee.d.ts.map
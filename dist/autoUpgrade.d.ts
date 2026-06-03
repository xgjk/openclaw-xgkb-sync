export interface AutoUpgradeOptions {
    enabled: boolean;
    /** 相对项目根目录或绝对路径 */
    scriptPath?: string;
    projectRoot: string;
    currentVersion: string;
    /** 是否有进行中的同步（为 true 时推迟升级） */
    isSyncIdle: () => boolean;
    log?: (msg: string) => void;
}
/**
 * 心跳发现新版本后的升级入口。
 * Node 进程无法安全地替换正在运行的自身代码，因此委托外部脚本完成：
 * git pull / npm install / build / pm2|systemd 重启。
 */
export declare function maybeScheduleAutoUpgrade(latestAppVersion: string | undefined, opts: AutoUpgradeOptions): void;
//# sourceMappingURL=autoUpgrade.d.ts.map
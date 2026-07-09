"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.maybeScheduleAutoUpgrade = maybeScheduleAutoUpgrade;
exports.buildUpgradeSpawnSpec = buildUpgradeSpawnSpec;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const versionCompare_1 = require("./versionCompare");
let upgradeInFlight = false;
let lastAttemptedTarget = null;
/**
 * 心跳发现新版本后的升级入口。
 * Node 进程无法安全地替换正在运行的自身代码，因此委托外部脚本完成：
 * git pull / npm install / build / pm2|systemd 重启。
 */
function maybeScheduleAutoUpgrade(latestAppVersion, opts) {
    if (!opts.enabled || !latestAppVersion?.trim())
        return;
    const latest = latestAppVersion.trim();
    const current = opts.currentVersion.trim();
    if (!current || current === 'unknown')
        return;
    if (!(0, versionCompare_1.isNewerVersion)(latest, current))
        return;
    if (upgradeInFlight)
        return;
    if (lastAttemptedTarget === latest)
        return;
    if (!opts.isSyncIdle()) {
        opts.log?.(`[AutoUpgrade] 发现新版本 ${latest}（当前 ${current}），同步进行中，推迟升级`);
        return;
    }
    const script = resolveUpgradeScript(opts.projectRoot, opts.scriptPath);
    if (!fs.existsSync(script)) {
        opts.log?.(`[AutoUpgrade] 升级脚本不存在: ${script}，请部署 scripts/auto-upgrade.*`);
        return;
    }
    upgradeInFlight = true;
    lastAttemptedTarget = latest;
    const spawnSpec = buildUpgradeSpawnSpec(script, latest, current);
    opts.log?.(`[AutoUpgrade] 触发升级 ${current} -> ${latest}，命令: ${spawnSpec.command} ${spawnSpec.args.join(' ')}`);
    const spawnOpts = {
        cwd: opts.projectRoot,
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            OPENCLAW_SYNC_TARGET_VERSION: latest,
            OPENCLAW_SYNC_CURRENT_VERSION: current,
            /** 与当前运行进程相同的 node，供升级脚本 build/重启（避免 Mac nvm PATH 丢失） */
            OPENCLAW_SYNC_NODE: process.execPath,
            OPENCLAW_SYNC_PROJECT_ROOT: opts.projectRoot,
        },
        ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    };
    const child = (0, child_process_1.spawn)(spawnSpec.command, spawnSpec.args, spawnOpts);
    child.unref();
    child.on('error', (e) => {
        upgradeInFlight = false;
        lastAttemptedTarget = null;
        opts.log?.(`[AutoUpgrade] 启动升级脚本失败: ${e instanceof Error ? e.message : String(e)}`);
    });
    // 脚本负责停服与重启；本进程可能被 SIGTERM，不再在这里 reset upgradeInFlight
}
/** 通过解释器启动，避免 Mac/Linux clone 后 .sh 无 +x 导致 EACCES */
function buildUpgradeSpawnSpec(script, targetVersion, currentVersion) {
    const ext = path.extname(script).toLowerCase();
    if (ext === '.ps1' || (process.platform === 'win32' && ext !== '.sh')) {
        return {
            command: resolveWindowsPowerShell(),
            args: [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                script,
                targetVersion,
                currentVersion,
            ],
        };
    }
    return {
        command: resolveUnixBash(),
        args: [script, targetVersion, currentVersion],
    };
}
function resolveUnixBash() {
    if (fs.existsSync('/bin/bash'))
        return '/bin/bash';
    return 'bash';
}
function resolveWindowsPowerShell() {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const pwsh = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(pwsh))
        return pwsh;
    return 'powershell.exe';
}
function resolveUpgradeScript(projectRoot, configured) {
    if (configured?.trim()) {
        return path.isAbsolute(configured) ? configured : path.resolve(projectRoot, configured);
    }
    if (process.env.OPENCLAW_DEPLOYMENT === 'docker') {
        const dockerScript = path.resolve(projectRoot, 'scripts', 'auto-upgrade.docker.sh');
        if (fs.existsSync(dockerScript))
            return dockerScript;
    }
    const ext = process.platform === 'win32' ? 'ps1' : 'sh';
    return path.resolve(projectRoot, 'scripts', `auto-upgrade.${ext}`);
}
//# sourceMappingURL=autoUpgrade.js.map
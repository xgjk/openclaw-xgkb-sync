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
exports.CentralReporter = void 0;
exports.isAutoUpgradeEnabled = isAutoUpgradeEnabled;
exports.resolveProjectRoot = resolveProjectRoot;
const path = __importStar(require("path"));
const autoUpgrade_1 = require("./autoUpgrade");
const centralConfigMerge_1 = require("./centralConfigMerge");
const scheduler_1 = require("./scheduler");
const constants_1 = require("./constants");
const versionCompare_1 = require("./versionCompare");
/** 是否启用自动升级（默认开启，仅显式 false 关闭） */
function isAutoUpgradeEnabled(config) {
    return config.autoUpgradeEnabled !== false;
}
class CentralReporter {
    opts;
    timer = null;
    heartbeatInFlight = false;
    stopped = false;
    constructor(opts) {
        this.opts = opts;
    }
    start() {
        const config = this.opts.getConfig();
        const url = config.centralManagerUrl?.trim();
        if (!url) {
            console.log('[CentralReporter] 未配置 centralManagerUrl，跳过 sync-manage 上报');
            return;
        }
        const intervalSec = Math.max(15, config.centralHeartbeatIntervalSec ?? constants_1.DEFAULT_CENTRAL_HEARTBEAT_INTERVAL_SEC);
        const upgradeHint = isAutoUpgradeEnabled(config) ? '自动升级已启用' : '自动升级已关闭';
        console.log(`[CentralReporter] 已启用，目标 ${url}，心跳间隔 ${intervalSec}s，nodeId=${this.opts.getNodeIdentity().nodeId}，${upgradeHint}`);
        const tick = () => void this.sendHeartbeat().catch((e) => {
            console.warn('[CentralReporter] 心跳异常:', e instanceof Error ? e.message : String(e));
        });
        tick();
        this.timer = setInterval(tick, intervalSec * 1000);
        this.timer.unref();
    }
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** 配置变更后重启心跳定时器（如 Web 保存 centralManagerUrl） */
    restart() {
        this.stop();
        this.stopped = false;
        this.heartbeatInFlight = false;
        this.start();
    }
    /** mapping 同步结束后上报 execution-log */
    reportExecutionLog(result) {
        const config = this.opts.getConfig();
        const baseUrl = config.centralManagerUrl?.trim();
        if (!baseUrl || this.stopped)
            return;
        const body = {
            mappingId: result.mappingId,
            triggerReason: result.triggerReason,
            startTime: result.startTime,
            endTime: result.endTime,
            uploaded: result.uploaded,
            downloaded: result.downloaded,
            deleted: result.deleted,
            skipped: result.skipped,
            failed: result.failed,
            ...(result.errorMsg ? { errorMsg: result.errorMsg } : {}),
        };
        void this.postJson(baseUrl, '/nologin/node/execution-log', body).catch((e) => {
            console.warn(`[CentralReporter] execution-log 上报失败 (${result.mappingId}):`, e instanceof Error ? e.message : String(e));
        });
    }
    async sendHeartbeat() {
        if (this.stopped || this.heartbeatInFlight)
            return;
        const config = this.opts.getConfig();
        const baseUrl = config.centralManagerUrl?.trim();
        if (!baseUrl)
            return;
        this.heartbeatInFlight = true;
        try {
            const scheduler = this.opts.getScheduler();
            const pressure = scheduler.getGlobalSyncPressure();
            const maxConcurrent = (0, scheduler_1.resolveMaxConcurrentMappings)(config);
            const identity = this.opts.getNodeIdentity();
            const body = {
                version: this.opts.appVersion,
                ipAddress: identity.advertiseIp,
                eventLoopLagMs: this.opts.getEventLoopLagMs(),
                globalSyncRunning: pressure.running,
                globalSyncMax: maxConcurrent,
                appKey: config.appKey ?? '',
                mappingStats: this.buildMappingStats(scheduler),
                localConfigVersion: config.localConfigVersion ?? 0,
                reportedConfig: (0, centralConfigMerge_1.buildReportedConfig)(config),
            };
            const data = await this.postJson(baseUrl, '/nologin/node/heartbeat', body);
            const latest = data.latestAppVersion?.trim();
            if (latest && isAutoUpgradeEnabled(config)) {
                if ((0, versionCompare_1.isNewerVersion)(latest, this.opts.appVersion)) {
                    console.log(`[CentralReporter] 中心发布新版本 ${latest}（当前 ${this.opts.appVersion}），检查是否可自动升级…`);
                }
                (0, autoUpgrade_1.maybeScheduleAutoUpgrade)(latest, {
                    enabled: true,
                    scriptPath: config.autoUpgradeScript,
                    projectRoot: this.opts.projectRoot,
                    currentVersion: this.opts.appVersion,
                    isSyncIdle: () => scheduler.isSyncIdle(),
                    log: (msg) => console.log(msg),
                });
            }
            // 节点侧自行维护 config.json，暂不应用中心下发的 config
            if (data.config && typeof data.config === 'object') {
                console.log('[CentralReporter] 心跳响应含 config 字段，已忽略（节点配置由本地 Web/文件维护）');
            }
        }
        finally {
            this.heartbeatInFlight = false;
        }
    }
    buildMappingStats(scheduler) {
        const runStatus = scheduler.getStatus();
        const out = {};
        for (const [mappingId, state] of Object.entries(runStatus)) {
            const lastState = state.lastState;
            const stats = lastState?.lastStats;
            out[mappingId] = {
                mappingId,
                lastSyncAt: lastState?.lastSuccessAt ?? null,
                lastTriggerReason: state.lastTriggerReason ?? null,
                uploaded: stats?.uploaded ?? 0,
                downloaded: stats?.downloaded ?? 0,
                deleted: stats?.deleted ?? 0,
                failed: stats?.failed ?? 0,
                errors: stats?.errors?.slice(0, 5) ?? [],
            };
        }
        return out;
    }
    async postJson(baseUrl, apiPath, body) {
        const url = `${baseUrl.replace(/\/+$/, '')}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Node-Id': this.opts.getNodeIdentity().nodeId,
            },
            body: JSON.stringify(body),
        });
        const text = await resp.text();
        let json;
        try {
            json = text ? JSON.parse(text) : {};
        }
        catch {
            throw new Error(`HTTP ${resp.status} 响应非 JSON: ${text.slice(0, 200)}`);
        }
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
        }
        const envelope = json;
        const ok = envelope.resultCode === 1 ||
            envelope.resultCode === 200 ||
            envelope.success === true;
        if (!ok) {
            throw new Error(envelope.resultMsg ?? `sync-manage 返回 resultCode=${envelope.resultCode}`);
        }
        return (envelope.data ?? {});
    }
}
exports.CentralReporter = CentralReporter;
/** 项目根目录（含 package.json） */
function resolveProjectRoot() {
    return path.resolve(__dirname, '..');
}
//# sourceMappingURL=centralReporter.js.map
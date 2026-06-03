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
exports.resolveProjectRoot = resolveProjectRoot;
const path = __importStar(require("path"));
const autoUpgrade_1 = require("./autoUpgrade");
const centralConfigMerge_1 = require("./centralConfigMerge");
const scheduler_1 = require("./scheduler");
const constants_1 = require("./constants");
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
        console.log(`[CentralReporter] 已启用，目标 ${url}，心跳间隔 ${intervalSec}s，nodeId=${this.opts.nodeId}`);
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
            const body = {
                version: this.opts.appVersion,
                ipAddress: this.opts.advertiseIp,
                eventLoopLagMs: this.opts.getEventLoopLagMs(),
                globalSyncRunning: pressure.running,
                globalSyncMax: maxConcurrent,
                appKey: config.appKey ?? '',
                mappingStats: this.buildMappingStats(scheduler),
                localConfigVersion: config.localConfigVersion ?? 0,
                reportedConfig: (0, centralConfigMerge_1.buildReportedConfig)(config),
            };
            const data = await this.postJson(baseUrl, '/nologin/node/heartbeat', body);
            (0, autoUpgrade_1.maybeScheduleAutoUpgrade)(data.latestAppVersion, {
                enabled: config.autoUpgradeEnabled === true,
                scriptPath: config.autoUpgradeScript,
                projectRoot: this.opts.projectRoot,
                currentVersion: this.opts.appVersion,
                isSyncIdle: () => scheduler.isSyncIdle(),
                log: (msg) => console.log(msg),
            });
            if (data.config && typeof data.config === 'object') {
                const configVersion = typeof data.configVersion === 'number' ? data.configVersion : undefined;
                if (configVersion == null) {
                    console.warn('[CentralReporter] 响应含 config 但缺少 configVersion，跳过 merge');
                    return;
                }
                (0, centralConfigMerge_1.applyCentralConfigPatch)({
                    configPath: this.opts.configPath,
                    local: config,
                    patch: data.config,
                    configVersion,
                    resetMappingState: (id) => scheduler.resetMappingState(id),
                });
                const reloadResult = await this.opts.onReload();
                if (!reloadResult.ok) {
                    console.warn(`[CentralReporter] 中心配置已写入但 reload 失败: ${reloadResult.error}`);
                }
                else {
                    console.log('[CentralReporter] 中心配置已 merge 并重载');
                }
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
                'X-Node-Id': this.opts.nodeId,
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
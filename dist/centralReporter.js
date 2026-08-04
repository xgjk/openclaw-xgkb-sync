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
const watchHelpers_1 = require("./watchHelpers");
/** 是否启用自动升级（默认开启，仅显式 false 关闭） */
function isAutoUpgradeEnabled(config) {
    return config.autoUpgradeEnabled !== false;
}
class CentralReporter {
    opts;
    timer = null;
    heartbeatInFlight = false;
    stopped = false;
    /** 同一 mapping 的待发送日志只保留最新一条，避免中心停服时无限堆积。 */
    pendingExecutionLogs = new Map();
    executionLogsInFlight = 0;
    activeControllers = new Set();
    droppedExecutionLogs = 0;
    consecutiveExecutionFailures = 0;
    executionPauseUntil = 0;
    executionDrainTimer = null;
    /** stop/restart 后，旧异步回调不得再修改新一代 reporter 状态。 */
    lifecycleGeneration = 0;
    constructor(opts) {
        this.opts = opts;
    }
    /** 资源诊断/测试：中心停服时可观察有界队列是否生效。 */
    getExecutionLogPressure() {
        return {
            inFlight: this.executionLogsInFlight,
            pending: this.pendingExecutionLogs.size,
            dropped: this.droppedExecutionLogs,
        };
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
        this.lifecycleGeneration++;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.pendingExecutionLogs.clear();
        this.droppedExecutionLogs = 0;
        this.consecutiveExecutionFailures = 0;
        this.executionPauseUntil = 0;
        if (this.executionDrainTimer) {
            clearTimeout(this.executionDrainTimer);
            this.executionDrainTimer = null;
        }
        for (const controller of this.activeControllers)
            controller.abort();
        this.activeControllers.clear();
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
        const mapping = config.mappings.find((m) => m.mappingId === result.mappingId);
        const syncDirection = mapping
            ? (0, watchHelpers_1.resolveMappingSyncDirection)(mapping, config.syncDirection)
            : config.syncDirection;
        const body = {
            mappingId: result.mappingId,
            syncDirection,
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
        // Map.set 会覆盖同一 mapping 尚未发送的旧记录：中心不可用时保留“最新状态”比
        // 无限制保存每一轮历史更安全。不同 mapping 仍有硬上限，防配置异常撑爆内存。
        if (!this.pendingExecutionLogs.has(result.mappingId) &&
            this.pendingExecutionLogs.size >= constants_1.CENTRAL_EXECUTION_LOG_MAX_PENDING) {
            const oldestMappingId = this.pendingExecutionLogs.keys().next().value;
            if (oldestMappingId)
                this.pendingExecutionLogs.delete(oldestMappingId);
            this.droppedExecutionLogs++;
        }
        else if (this.pendingExecutionLogs.has(result.mappingId)) {
            this.droppedExecutionLogs++;
        }
        this.pendingExecutionLogs.set(result.mappingId, { baseUrl, body });
        this.drainExecutionLogs();
    }
    drainExecutionLogs() {
        if (this.stopped)
            return;
        const backoffRemaining = this.executionPauseUntil - Date.now();
        if (backoffRemaining > 0) {
            if (!this.executionDrainTimer) {
                this.executionDrainTimer = setTimeout(() => {
                    this.executionDrainTimer = null;
                    this.drainExecutionLogs();
                }, backoffRemaining);
                this.executionDrainTimer.unref();
            }
            return;
        }
        while (this.executionLogsInFlight < constants_1.CENTRAL_EXECUTION_LOG_CONCURRENCY &&
            this.pendingExecutionLogs.size > 0) {
            const next = this.pendingExecutionLogs.entries().next().value;
            if (!next)
                return;
            const [mappingId, item] = next;
            this.pendingExecutionLogs.delete(mappingId);
            this.executionLogsInFlight++;
            const generation = this.lifecycleGeneration;
            void this.postJson(item.baseUrl, '/nologin/node/execution-log', item.body)
                .then(() => {
                if (this.stopped || generation !== this.lifecycleGeneration)
                    return;
                this.consecutiveExecutionFailures = 0;
                this.executionPauseUntil = 0;
            })
                .catch((e) => {
                if (this.stopped || generation !== this.lifecycleGeneration)
                    return;
                this.consecutiveExecutionFailures++;
                const backoffMs = Math.min(constants_1.CENTRAL_REPORT_MAX_BACKOFF_MS, 1_000 * Math.pow(2, Math.min(this.consecutiveExecutionFailures - 1, 10)));
                this.executionPauseUntil = Math.max(this.executionPauseUntil, Date.now() + backoffMs);
                console.warn(`[CentralReporter] execution-log 上报失败 (${mappingId}):`, `${e instanceof Error ? e.message : String(e)}；退避 ${Math.round(backoffMs / 1000)}s`);
            })
                .finally(() => {
                this.executionLogsInFlight--;
                if (!this.stopped &&
                    generation === this.lifecycleGeneration &&
                    this.droppedExecutionLogs > 0) {
                    console.warn(`[CentralReporter] 中心上报拥塞，已合并/舍弃 ${this.droppedExecutionLogs} 条旧 execution-log` +
                        `（待发送=${this.pendingExecutionLogs.size}，进行中=${this.executionLogsInFlight}）`);
                    this.droppedExecutionLogs = 0;
                }
                this.drainExecutionLogs();
            });
        }
    }
    async sendHeartbeat() {
        if (this.stopped || this.heartbeatInFlight)
            return;
        const generation = this.lifecycleGeneration;
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
            if (this.stopped || generation !== this.lifecycleGeneration)
                return;
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
            if (generation === this.lifecycleGeneration)
                this.heartbeatInFlight = false;
        }
    }
    buildMappingStats(scheduler) {
        const config = this.opts.getConfig();
        const runStatus = scheduler.getStatus();
        const out = {};
        for (const mapping of config.mappings) {
            const mappingId = mapping.mappingId;
            const state = runStatus[mappingId];
            const lastState = state?.lastState;
            const stats = lastState?.lastStats;
            out[mappingId] = {
                mappingId,
                syncDirection: (0, watchHelpers_1.resolveMappingSyncDirection)(mapping, config.syncDirection),
                lastSyncAt: lastState?.lastSuccessAt ?? null,
                lastTriggerReason: state?.lastTriggerReason ?? null,
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
        const controller = new AbortController();
        this.activeControllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), constants_1.CENTRAL_REPORT_TIMEOUT_MS);
        timeout.unref();
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Node-Id': this.opts.getNodeIdentity().nodeId,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            // 超时覆盖响应 body 读取；仅限制到 headers 会让“已回 headers 但 body 卡住”的连接永久悬挂。
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
        catch (e) {
            if (e instanceof Error && e.name === 'AbortError') {
                const timeoutError = new Error(`sync-manage 上报超时（>${constants_1.CENTRAL_REPORT_TIMEOUT_MS}ms）`);
                timeoutError.name = 'AbortError';
                throw timeoutError;
            }
            throw e;
        }
        finally {
            clearTimeout(timeout);
            this.activeControllers.delete(controller);
        }
    }
}
exports.CentralReporter = CentralReporter;
/** 项目根目录（含 package.json） */
function resolveProjectRoot() {
    return path.resolve(__dirname, '..');
}
//# sourceMappingURL=centralReporter.js.map
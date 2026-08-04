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
exports.ManagementApi = void 0;
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const scheduler_1 = require("./scheduler");
const config_1 = require("./config");
const pathSyncScope_1 = require("./pathSyncScope");
const managementApiCredentials_1 = require("./managementApiCredentials");
const watchHelpers_1 = require("./watchHelpers");
const version_1 = require("./version");
const ensureLocalRoot_1 = require("./ensureLocalRoot");
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const MAX_MANAGEMENT_REQUEST_BODY_BYTES = 1024 * 1024;
/** 仅用于界面展示的脱敏 AppKey，避免返回明文。 */
function maskSecret(value) {
    const secret = value?.trim();
    if (!secret)
        return undefined;
    if (secret.length <= 8)
        return `${secret[0] ?? ''}${'•'.repeat(Math.max(secret.length - 2, 1))}${secret.slice(-1)}`;
    return `${secret.slice(0, 4)}${'•'.repeat(Math.min(secret.length - 8, 24))}${secret.slice(-4)}`;
}
/** 可通过 PUT /config 修改的全局字段（managementPort/Host 需重启进程才生效） */
const EDITABLE_CONFIG_FIELDS = [
    'serverUrl',
    'appKey',
    'syncDirection',
    'autoSyncIntervalSec',
    'fullReconcileIntervalSec',
    'stateDbPath',
    'maxConcurrentMappingsMode',
    'maxConcurrentMappings',
    'maxRequestsPerMinute',
    'rateLimitBurst',
    'rateLimitCooldownSec',
    'downloadConcurrency',
    'uploadConcurrency',
    'maxFileSizeBytes',
    'startupJitterMaxSec',
    'managementPort',
    'managementHost',
    'watchEnabled',
    'pushDebounceMs',
    'watchUsePolling',
    'syncDotFiles',
    'centralManagerUrl',
    'centralHeartbeatIntervalSec',
    'autoUpgradeEnabled',
    'autoUpgradeScript',
    'nodeId',
    'nodeAdvertiseIp',
];
/**
 * HTTP 管理 API 服务
 *
 * 路由速览见类内 `start()` 日志。完整契约见仓库 **docs/MANAGEMENT_API.md**（给 AI / 自动化）；appKey 保存规则见 **src/managementApiCredentials.ts**。
 */
class ManagementApi {
    opts;
    startedAt = Date.now();
    server = null;
    /** 事件循环延迟（ms），用于判断 HTTP 是否可能被同步阻塞 */
    lastEventLoopLagMs = 0;
    eventLoopTimer = null;
    constructor(opts) {
        this.opts = opts;
    }
    start() {
        if (this.opts.port === 0) {
            console.log('[ManagementApi] port=0，管理 API 已禁用');
            return;
        }
        this.server = http.createServer((req, res) => {
            this.handle(req, res).catch((e) => {
                console.error('[ManagementApi] 请求处理异常:', e);
                this.sendJson(res, 500, { ok: false, error: 'internal error' });
            });
        });
        // 长请求（reload / status）可等待；黑盒探针应单独用 /health 且超时 ≥10s
        this.server.timeout = 120_000;
        this.eventLoopTimer = setInterval(() => {
            const t0 = Date.now();
            setImmediate(() => {
                this.lastEventLoopLagMs = Date.now() - t0;
            });
        }, 1000);
        this.eventLoopTimer.unref();
        this.server.listen(this.opts.port, this.opts.host, () => {
            console.log(`[ManagementApi] 已启动，监听 http://${this.opts.host}:${this.opts.port}`);
            console.log(`[ManagementApi] 可用接口:`);
            console.log(`  GET    /health`);
            console.log(`  GET    /status`);
            console.log(`  GET    /mappings`);
            console.log(`  POST   /mappings          新增 mapping`);
            console.log(`  PUT    /mappings/:id       upsert mapping（存在则更新，不存在则创建）`);
            console.log(`  DELETE /mappings/:id       删除 mapping`);
            console.log(`  POST   /mappings/:id/enable  启用 mapping`);
            console.log(`  POST   /mappings/:id/disable 禁用 mapping`);
            console.log(`  POST   /mappings/disable-by-local-prefix  按 localRoot 前缀批量禁用`);
            console.log(`  POST   /mappings/:id/reset 重置同步状态（清空 DB）`);
            console.log(`  POST   /sync/:mappingId`);
            console.log(`  POST   /sync  （触发所有）`);
            console.log(`  POST   /reload`);
            console.log(`  GET    /config`);
            console.log(`  PUT    /config`);
            console.log(`  GET    /          管理控制台（静态页面）`);
        });
        this.server.on('error', (e) => {
            console.error('[ManagementApi] 服务器错误:', e);
        });
    }
    stop() {
        if (this.eventLoopTimer) {
            clearInterval(this.eventLoopTimer);
            this.eventLoopTimer = null;
        }
        if (this.server) {
            this.server.close();
            this.server = null;
            console.log('[ManagementApi] 已停止');
        }
    }
    getEventLoopLagMs() {
        return this.lastEventLoopLagMs;
    }
    invokeReload() {
        return Promise.resolve(this.opts.onReload());
    }
    async handle(req, res) {
        const method = req.method ?? 'GET';
        const url = req.url ?? '/';
        const urlPath = url.split('?')[0];
        // GET /health — 最先处理，仅证明进程与事件循环可响应（不访问 SQLite）
        if (method === 'GET' && urlPath === '/health') {
            return this.handleHealth(res);
        }
        // GET / — 管理控制台
        if (method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
            return this.serveStaticFile(res, 'index.html');
        }
        // GET /static/*
        if (method === 'GET' && urlPath.startsWith('/static/')) {
            const rel = 'static/' + urlPath.slice('/static/'.length);
            return this.serveStaticFile(res, rel);
        }
        // GET /status
        if (method === 'GET' && urlPath === '/status') {
            return this.handleStatus(res);
        }
        // POST /reload
        if (method === 'POST' && urlPath === '/reload') {
            return this.handleReload(res);
        }
        // POST /sync  （触发所有 mapping）
        if (method === 'POST' && urlPath === '/sync') {
            return this.handleSyncAll(res);
        }
        // POST /sync/:mappingId
        const syncMatch = urlPath.match(/^\/sync\/(.+)$/);
        if (method === 'POST' && syncMatch) {
            return this.handleSyncOne(res, decodeURIComponent(syncMatch[1]));
        }
        // GET /config
        if (method === 'GET' && urlPath === '/config') {
            return this.handleGetConfig(res);
        }
        // PUT /config
        if (method === 'PUT' && urlPath === '/config') {
            return this.handleUpdateConfig(req, res);
        }
        // GET /mappings
        if (method === 'GET' && urlPath === '/mappings') {
            return this.handleListMappings(res);
        }
        // POST /mappings  （新增）
        if (method === 'POST' && urlPath === '/mappings') {
            return this.handleCreateMapping(req, res);
        }
        // POST /mappings/disable-by-local-prefix  （按 localRoot 前缀批量禁用）
        if (method === 'POST' && urlPath === '/mappings/disable-by-local-prefix') {
            return this.handleDisableByLocalPrefix(req, res);
        }
        // POST /mappings/:mappingId/reset  （重置同步状态：清空文件/文件夹记录+水位）
        const resetMatch = urlPath.match(/^\/mappings\/([^/]+)\/reset$/);
        if (method === 'POST' && resetMatch) {
            return this.handleResetMapping(res, decodeURIComponent(resetMatch[1]));
        }
        // POST /mappings/:mappingId/enable | /disable  （切换启用状态，供 Web 与其它业务调用）
        const enableMatch = urlPath.match(/^\/mappings\/([^/]+)\/enable$/);
        if (method === 'POST' && enableMatch) {
            return this.handleSetMappingEnabled(res, decodeURIComponent(enableMatch[1]), true);
        }
        const disableMatch = urlPath.match(/^\/mappings\/([^/]+)\/disable$/);
        if (method === 'POST' && disableMatch) {
            return this.handleSetMappingEnabled(res, decodeURIComponent(disableMatch[1]), false);
        }
        // PUT /mappings/:mappingId  （upsert：存在则更新，不存在则创建）
        const putMatch = urlPath.match(/^\/mappings\/(.+)$/);
        if (method === 'PUT' && putMatch) {
            return this.handleUpsertMapping(req, res, decodeURIComponent(putMatch[1]));
        }
        // DELETE /mappings/:mappingId  （删除）
        const deleteMatch = urlPath.match(/^\/mappings\/(.+)$/);
        if (method === 'DELETE' && deleteMatch) {
            return this.handleDeleteMapping(res, decodeURIComponent(deleteMatch[1]));
        }
        this.sendJson(res, 404, { ok: false, error: `未知路由: ${method} ${urlPath}` });
    }
    // ==================== 路由处理 ====================
    handleHealth(res) {
        const scheduler = this.opts.getScheduler();
        const config = scheduler.getConfig();
        const enabledCount = config.mappings.filter((m) => m.enabled).length;
        const pressure = scheduler.getGlobalSyncPressure();
        const watcherPressure = scheduler.getWatcherPressure();
        const memory = process.memoryUsage();
        const overloaded = pressure.running >= pressure.max && pressure.max > 0;
        const highLag = this.lastEventLoopLagMs > 15_000;
        // 能执行到这里说明事件循环未完全卡死；黑盒探针应认 200，负载用字段表达
        const id = this.opts.getNodeIdentity();
        this.sendJson(res, 200, {
            ok: true,
            version: version_1.APP_VERSION,
            nodeId: id.nodeId,
            advertiseIp: id.advertiseIp,
            nodeIdSource: id.source,
            pid: process.pid,
            uptime: Math.floor((Date.now() - this.startedAt) / 1000),
            startedAt: new Date(this.startedAt).toISOString(),
            mappingCount: config.mappings.length,
            enabledMappingCount: enabledCount,
            nodeVersion: process.version,
            eventLoopLagMs: this.lastEventLoopLagMs,
            globalSyncRunning: pressure.running,
            globalSyncMax: pressure.max,
            watcherMappings: watcherPressure.mappings,
            watcherBackends: watcherPressure.backends,
            watchedDirectories: watcherPressure.watchedDirectories,
            memory: {
                rss: memory.rss,
                heapUsed: memory.heapUsed,
                heapTotal: memory.heapTotal,
                external: memory.external,
                arrayBuffers: memory.arrayBuffers,
            },
            degraded: highLag || overloaded,
            ...(highLag && {
                warn: 'event_loop_lag_high',
                hint: '同步阻塞事件循环，HTTP 可能间歇超时；请调大黑盒 timeout 或降低并行同步',
            }),
            ...(overloaded && {
                warn: 'global_sync_saturated',
                hint: '全局同步并发已满，新任务在排队',
            }),
        });
    }
    handleStatus(res) {
        const scheduler = this.opts.getScheduler();
        const config = scheduler.getConfig();
        const runStatus = scheduler.getStatus();
        // 整理 mapping 状态，附加配置摘要，隐藏敏感字段
        const mappings = {};
        for (const [mappingId, state] of Object.entries(runStatus)) {
            const mapping = config.mappings.find((m) => m.mappingId === mappingId);
            mappings[mappingId] = {
                enabled: mapping?.enabled ?? true,
                localRoot: mapping?.localRoot,
                remoteRootFolderPath: mapping?.remoteRootFolderPath,
                syncDirection: mapping?.syncDirection ?? config.syncDirection,
                watchEnabledEffective: mapping
                    ? (0, watchHelpers_1.resolveWatchEnabled)(mapping, config)
                    : false,
                watchActive: state.watchActive,
                lastTriggerReason: state.lastTriggerReason ?? null,
                lastWatchTriggerAt: state.lastWatchTriggerAt ?? null,
                isSyncing: state.isSyncing,
                pendingSync: state.pendingSync,
                lastState: state.lastState,
            };
        }
        this.sendJson(res, 200, {
            version: version_1.APP_VERSION,
            pid: process.pid,
            uptime: Math.floor((Date.now() - this.startedAt) / 1000),
            startedAt: new Date(this.startedAt).toISOString(),
            nodeVersion: process.version,
            config: {
                serverUrl: config.serverUrl,
                syncDirection: config.syncDirection,
                autoSyncIntervalSec: config.autoSyncIntervalSec,
                fullReconcileIntervalSec: config.fullReconcileIntervalSec,
                watchEnabled: config.watchEnabled,
                pushDebounceMs: config.pushDebounceMs,
                watchUsePolling: config.watchUsePolling,
                syncDotFiles: config.syncDotFiles,
                maxConcurrentMappings: config.maxConcurrentMappings,
                maxConcurrentMappingsMode: config.maxConcurrentMappingsMode,
                effectiveMaxConcurrentMappings: (0, scheduler_1.resolveMaxConcurrentMappings)(config),
                maxRequestsPerMinute: config.maxRequestsPerMinute,
                mappingCount: config.mappings.length,
                enabledMappingCount: config.mappings.filter((m) => m.enabled).length,
            },
            mappings,
        });
    }
    async handleReload(res) {
        console.log('[ManagementApi] 收到 /reload 请求，重载配置...');
        const result = await this.invokeReload();
        if (!result.ok) {
            console.error('[ManagementApi] 配置重载失败:', result.error);
            return this.sendJson(res, 400, { ok: false, error: result.error });
        }
        const config = result.config;
        console.log('[ManagementApi] 配置重载成功，mapping 数量:', config.mappings.length);
        this.sendJson(res, 200, {
            ok: true,
            message: `配置已重载，mapping 数量: ${config.mappings.length}（已启用: ${config.mappings.filter((m) => m.enabled).length}）`,
            mappingCount: config.mappings.length,
            enabledMappingCount: config.mappings.filter((m) => m.enabled).length,
        });
    }
    handleSyncAll(res) {
        const scheduler = this.opts.getScheduler();
        const config = scheduler.getConfig();
        const enabled = config.mappings.filter((m) => (0, config_1.isMappingEffectiveEnabled)(m, config.mappings));
        for (const m of enabled) {
            scheduler.triggerMapping(m.mappingId);
        }
        this.sendJson(res, 200, {
            ok: true,
            message: `已触发 ${enabled.length} 个 mapping 同步`,
            triggered: enabled.map((m) => m.mappingId),
        });
    }
    handleSyncOne(res, mappingId) {
        const scheduler = this.opts.getScheduler();
        const config = scheduler.getConfig();
        const mapping = config.mappings.find((m) => m.mappingId === mappingId);
        if (!mapping) {
            return this.sendJson(res, 404, {
                ok: false,
                error: `未找到 mapping: "${mappingId}"`,
                availableMappings: config.mappings.map((m) => m.mappingId),
            });
        }
        if (!(0, config_1.isMappingEffectiveEnabled)(mapping, config.mappings)) {
            const reason = mapping.enabled
                ? 'localRoot 与其他映射冲突，仅列表中先出现的已启用项可同步'
                : 'mapping 已禁用（enabled=false）';
            return this.sendJson(res, 400, {
                ok: false,
                error: `无法同步 mapping "${mappingId}"：${reason}`,
            });
        }
        scheduler.triggerMapping(mappingId);
        this.sendJson(res, 200, { ok: true, message: `已触发同步: ${mappingId}` });
    }
    // ==================== 全局配置 ====================
    handleGetConfig(res) {
        const config = this.opts.getScheduler().getConfig();
        const identity = this.opts.getNodeIdentity();
        this.sendJson(res, 200, {
            ok: true,
            hasGlobalAppKey: !!(config.appKey && config.appKey.trim()),
            config: this.globalConfigSummary(config, identity),
        });
    }
    async handleUpdateConfig(req, res) {
        let body;
        try {
            body = await this.readBody(req);
        }
        catch (e) {
            return this.sendJson(res, 400, {
                ok: false,
                error: `请求体解析失败: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
        if (typeof body !== 'object' || body === null) {
            return this.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
        }
        const bodyObj = body;
        const unknownKeys = Object.keys(bodyObj).filter((k) => !EDITABLE_CONFIG_FIELDS.includes(k));
        if (unknownKeys.length > 0) {
            return this.sendJson(res, 400, {
                ok: false,
                error: `不支持的配置字段: ${unknownKeys.join(', ')}`,
            });
        }
        if (Object.keys(bodyObj).length === 0) {
            return this.sendJson(res, 400, { ok: false, error: '请至少提供一个要修改的字段' });
        }
        const prevConfig = this.opts.getScheduler().getConfig();
        const requiresRestartFields = [];
        const writeResult = this.modifyConfigRoot((raw) => {
            for (const key of EDITABLE_CONFIG_FIELDS) {
                if (!(key in bodyObj))
                    continue;
                const val = bodyObj[key];
                if (key === 'appKey') {
                    if (val === null || val === '') {
                        delete raw.appKey;
                    }
                    else if (typeof val === 'string') {
                        raw.appKey = val.trim();
                    }
                    else {
                        throw new Error('appKey 必须是字符串或 null');
                    }
                    continue;
                }
                if (key === 'serverUrl') {
                    if (typeof val !== 'string' || !val.trim()) {
                        throw new Error('serverUrl 必须是非空字符串');
                    }
                    raw.serverUrl = val.trim();
                    continue;
                }
                if (key === 'syncDirection') {
                    if (!['bidirectional', 'push', 'pull'].includes(val)) {
                        throw new Error('syncDirection 必须是 bidirectional | push | pull');
                    }
                    raw.syncDirection = val;
                    continue;
                }
                if (key === 'managementHost') {
                    if (typeof val !== 'string' || !val.trim()) {
                        throw new Error('managementHost 必须是非空字符串');
                    }
                    if (val !== prevConfig.managementHost)
                        requiresRestartFields.push('managementHost');
                    raw.managementHost = val.trim();
                    continue;
                }
                if (key === 'managementPort') {
                    if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
                        throw new Error('managementPort 必须是非负整数');
                    }
                    if (val !== prevConfig.managementPort)
                        requiresRestartFields.push('managementPort');
                    raw.managementPort = val;
                    continue;
                }
                if (key === 'autoSyncIntervalSec' ||
                    key === 'fullReconcileIntervalSec' ||
                    key === 'maxRequestsPerMinute' ||
                    key === 'rateLimitBurst' ||
                    key === 'rateLimitCooldownSec' ||
                    key === 'downloadConcurrency' ||
                    key === 'uploadConcurrency' ||
                    key === 'maxFileSizeBytes' ||
                    key === 'startupJitterMaxSec') {
                    if (typeof val !== 'number' || val < 0) {
                        throw new Error(`${key} 必须是非负数`);
                    }
                    raw[key] = val;
                    continue;
                }
                if (key === 'pushDebounceMs') {
                    if (typeof val !== 'number' || val < 100) {
                        throw new Error('pushDebounceMs 必须是 >= 100 的数字');
                    }
                    raw.pushDebounceMs = val;
                    continue;
                }
                if (key === 'watchEnabled' || key === 'watchUsePolling' || key === 'syncDotFiles') {
                    if (typeof val !== 'boolean') {
                        throw new Error(`${key} 必须是 boolean`);
                    }
                    raw[key] = val;
                    continue;
                }
                if (key === 'maxConcurrentMappingsMode') {
                    if (val !== 'auto' && val !== 'manual') {
                        throw new Error('maxConcurrentMappingsMode 必须是 auto | manual');
                    }
                    raw.maxConcurrentMappingsMode = val;
                    continue;
                }
                if (key === 'maxConcurrentMappings') {
                    if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
                        throw new Error('maxConcurrentMappings 必须是正整数');
                    }
                    raw.maxConcurrentMappings = val;
                    continue;
                }
                if (key === 'centralManagerUrl') {
                    if (val === null || val === '') {
                        delete raw.centralManagerUrl;
                    }
                    else if (typeof val === 'string') {
                        raw.centralManagerUrl = val.trim().replace(/\/+$/, '');
                    }
                    else {
                        throw new Error('centralManagerUrl 必须是字符串或 null');
                    }
                    continue;
                }
                if (key === 'centralHeartbeatIntervalSec') {
                    if (typeof val !== 'number' || !Number.isInteger(val) || val < 15) {
                        throw new Error('centralHeartbeatIntervalSec 必须是 >= 15 的整数');
                    }
                    raw.centralHeartbeatIntervalSec = val;
                    continue;
                }
                if (key === 'autoUpgradeEnabled') {
                    if (typeof val !== 'boolean') {
                        throw new Error('autoUpgradeEnabled 必须是 boolean');
                    }
                    raw.autoUpgradeEnabled = val;
                    continue;
                }
                if (key === 'autoUpgradeScript') {
                    if (val === null || val === '') {
                        delete raw.autoUpgradeScript;
                    }
                    else if (typeof val === 'string') {
                        raw.autoUpgradeScript = val.trim();
                    }
                    else {
                        throw new Error('autoUpgradeScript 必须是字符串或 null');
                    }
                    continue;
                }
                if (key === 'nodeId') {
                    if (val === null || val === '') {
                        delete raw.nodeId;
                    }
                    else if (typeof val === 'string') {
                        const id = val.trim();
                        if (/^127\.0\.0\.1(?::|$)/.test(id) || id.startsWith('localhost')) {
                            throw new Error('nodeId 不能使用 127.0.0.1 或 localhost');
                        }
                        raw.nodeId = id;
                    }
                    else {
                        throw new Error('nodeId 必须是字符串或 null');
                    }
                    continue;
                }
                if (key === 'nodeAdvertiseIp') {
                    if (val === null || val === '') {
                        delete raw.nodeAdvertiseIp;
                    }
                    else if (typeof val === 'string') {
                        const ip = val.trim();
                        if (/^127\./.test(ip)) {
                            throw new Error('nodeAdvertiseIp 不能使用回环地址');
                        }
                        raw.nodeAdvertiseIp = ip;
                    }
                    else {
                        throw new Error('nodeAdvertiseIp 必须是字符串或 null');
                    }
                    continue;
                }
                if (key === 'stateDbPath') {
                    if (typeof val !== 'string' || !val.trim()) {
                        throw new Error('stateDbPath 必须是非空字符串');
                    }
                    raw.stateDbPath = val.trim();
                }
            }
            return raw;
        });
        if (!writeResult.ok) {
            return this.sendJson(res, 400, { ok: false, error: writeResult.error });
        }
        const reloadResult = await this.invokeReload();
        if (!reloadResult.ok) {
            return this.sendJson(res, 500, {
                ok: false,
                error: `配置已写入但重载失败: ${reloadResult.error}`,
            });
        }
        console.log('[ManagementApi] 全局配置已更新');
        this.sendJson(res, 200, {
            ok: true,
            message: '全局配置已更新并生效',
            hasGlobalAppKey: !!(reloadResult.config.appKey && reloadResult.config.appKey.trim()),
            config: this.globalConfigSummary(reloadResult.config, this.opts.getNodeIdentity()),
            ...(requiresRestartFields.length > 0 && {
                warnings: [
                    `字段 [${requiresRestartFields.join(', ')}] 已写入 config.json，但需重启进程后才会生效`,
                ],
            }),
        });
    }
    // ==================== Mapping CRUD ====================
    handleListMappings(res) {
        let fileMappings;
        try {
            fileMappings = (0, config_1.readMappingsFromConfigFile)(this.opts.configPath);
        }
        catch (e) {
            return this.sendJson(res, 500, {
                ok: false,
                error: `读取 config.json mappings 失败: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
        const schedulerConfig = this.opts.getScheduler().getConfig();
        const duplicateGroups = (0, config_1.findDuplicateLocalRootGroups)(fileMappings);
        const conflictIds = new Set(duplicateGroups.flatMap((g) => g.mappingIds));
        const schedulerIds = new Set(schedulerConfig.mappings.map((m) => m.mappingId));
        this.sendJson(res, 200, {
            ok: true,
            total: fileMappings.length,
            hasGlobalAppKey: !!(schedulerConfig.appKey && schedulerConfig.appKey.trim()),
            configConflict: duplicateGroups.length > 0,
            duplicateLocalRoots: duplicateGroups,
            reloadPending: fileMappings.some((m) => !schedulerIds.has(m.mappingId))
                || schedulerConfig.mappings.some((m) => !fileMappings.some((f) => f.mappingId === m.mappingId)),
            mappings: fileMappings.map((m) => ({
                ...this.mappingSummary(m, schedulerConfig),
                localRootConflict: conflictIds.has(m.mappingId),
                syncEffective: (0, config_1.isMappingEffectiveEnabled)(m, fileMappings),
                activeInScheduler: schedulerIds.has(m.mappingId),
            })),
        });
    }
    async handleCreateMapping(req, res) {
        let body;
        try {
            body = await this.readBody(req);
        }
        catch (e) {
            return this.sendJson(res, 400, { ok: false, error: `请求体解析失败: ${e instanceof Error ? e.message : String(e)}` });
        }
        if (typeof body !== 'object' || body === null) {
            return this.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
        }
        const bodyObj = { ...body };
        let existingIds;
        try {
            existingIds = (0, config_1.readMappingsFromConfigFile)(this.opts.configPath).map((m) => m.mappingId);
        }
        catch {
            existingIds = this.opts.getScheduler().getConfig().mappings.map((m) => m.mappingId);
        }
        const mid = bodyObj.mappingId;
        if (typeof mid !== 'string' || !mid.trim()) {
            bodyObj.mappingId = (0, config_1.generateUniqueMappingId)(existingIds);
        }
        // 校验 mapping 字段（配置文件中的条目仍要求 mappingId；此处已为 POST 补全）
        let mapping;
        try {
            mapping = (0, config_1.validateMapping)(bodyObj, 0, '<API 请求>');
        }
        catch (e) {
            return this.sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        const cfg = this.opts.getScheduler().getConfig();
        const cred = (0, managementApiCredentials_1.getMappingCredentialsViolation)(cfg, mapping);
        if (cred) {
            return this.sendJson(res, 400, {
                ok: false,
                error: cred.error,
                errorCode: cred.errorCode,
            });
        }
        // 写入 config.json
        let fileMappings;
        try {
            fileMappings = (0, config_1.readMappingsFromConfigFile)(this.opts.configPath);
            if (fileMappings.some((m) => m.mappingId === mapping.mappingId)) {
                throw new Error(`mappingId "${mapping.mappingId}" 已存在，如需修改请使用 PUT /mappings/${mapping.mappingId}`);
            }
        }
        catch (e) {
            return this.sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        const downgraded = (0, config_1.downgradeMappingIfLocalRootConflict)(mapping, [...fileMappings, mapping]);
        mapping = downgraded.mapping;
        const saveWarnings = downgraded.warning ? [downgraded.warning] : [];
        if (!this.ensureLocalRootOrRespond(res, mapping))
            return;
        const writeResult = this.modifyConfigMappings((mappings) => {
            if (mappings.some((m) => m.mappingId === mapping.mappingId)) {
                throw new Error(`mappingId "${mapping.mappingId}" 已存在，如需修改请使用 PUT /mappings/${mapping.mappingId}`);
            }
            return [...mappings, mapping];
        });
        if (!writeResult.ok) {
            return this.sendJson(res, 400, { ok: false, error: writeResult.error });
        }
        // 热重载使新 mapping 立即生效
        const reloadResult = await this.invokeReload();
        if (!reloadResult.ok) {
            console.warn(`[ManagementApi] mapping "${mapping.mappingId}" 已写入但热重载失败: ${reloadResult.error}`);
            return this.sendJson(res, 201, {
                ok: true,
                reloadOk: false,
                message: `mapping "${mapping.mappingId}" 已保存`,
                warning: `热重载未完全生效: ${reloadResult.error}`,
                warnings: saveWarnings,
                mapping: this.mappingSummary(mapping),
            });
        }
        console.log(`[ManagementApi] 新增 mapping: ${mapping.mappingId}`);
        this.sendJson(res, 201, {
            ok: true,
            reloadOk: true,
            message: downgraded.downgraded
                ? `mapping "${mapping.mappingId}" 已保存（因 localRoot 冲突已自动禁用）`
                : `mapping "${mapping.mappingId}" 已创建并生效`,
            warnings: saveWarnings,
            mapping: this.mappingSummary(mapping),
        });
    }
    /** PUT /mappings/:mappingId — 存在则部分更新，不存在则按请求体创建（upsert） */
    async handleUpsertMapping(req, res, mappingId) {
        let body;
        try {
            body = await this.readBody(req);
        }
        catch (e) {
            return this.sendJson(res, 400, { ok: false, error: `请求体解析失败: ${e instanceof Error ? e.message : String(e)}` });
        }
        if (typeof body !== 'object' || body === null) {
            return this.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
        }
        const bodyObj = body;
        if ('mappingId' in bodyObj && bodyObj.mappingId !== mappingId) {
            return this.sendJson(res, 400, {
                ok: false,
                error: `请求体中的 mappingId "${bodyObj.mappingId}" 与 URL 中的 "${mappingId}" 不一致`,
            });
        }
        const IDENTITY_FIELDS = [
            'localRoot', 'remoteRootFolderPath', 'remoteRootFileId', 'projectId', 'appKey',
        ];
        let mapping;
        let existingMapping;
        let created = false;
        let saveWarnings = [];
        try {
            const fileMappings = (0, config_1.readMappingsFromConfigFile)(this.opts.configPath);
            const idx = fileMappings.findIndex((m) => m.mappingId === mappingId);
            const cfg = this.opts.getScheduler().getConfig();
            if (idx === -1) {
                created = true;
                const merged = { ...bodyObj, mappingId };
                mapping = (0, config_1.validateMapping)(merged, 0, '<API 请求>');
                const cred = (0, managementApiCredentials_1.getMappingCredentialsViolation)(cfg, mapping);
                if (cred) {
                    const err = new Error(cred.error);
                    err.errorCode = cred.errorCode;
                    throw err;
                }
                const downgraded = (0, config_1.downgradeMappingIfLocalRootConflict)(mapping, [...fileMappings, mapping]);
                mapping = downgraded.mapping;
                if (downgraded.warning)
                    saveWarnings = [downgraded.warning];
            }
            else {
                existingMapping = fileMappings[idx];
                const merged = { ...existingMapping, ...bodyObj, mappingId };
                mapping = (0, config_1.validateMapping)(merged, 0, '<API 请求>');
                const cred = (0, managementApiCredentials_1.getMappingCredentialsViolation)(cfg, mapping);
                if (cred) {
                    const err = new Error(cred.error);
                    err.errorCode = cred.errorCode;
                    throw err;
                }
                const next = [...fileMappings];
                next[idx] = mapping;
                const downgraded = (0, config_1.downgradeMappingIfLocalRootConflict)(mapping, next);
                mapping = downgraded.mapping;
                if (downgraded.warning)
                    saveWarnings = [downgraded.warning];
            }
        }
        catch (e) {
            const errorCode = e &&
                typeof e === 'object' &&
                'errorCode' in e &&
                typeof e.errorCode === 'string'
                ? e.errorCode
                : undefined;
            return this.sendJson(res, 400, {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
                ...(errorCode ? { errorCode } : {}),
            });
        }
        const localRootChanged = !created && existingMapping != null && existingMapping.localRoot !== mapping.localRoot;
        if (created || localRootChanged) {
            if (!this.ensureLocalRootOrRespond(res, mapping))
                return;
        }
        const writeResult = this.modifyConfigMappings((mappings) => {
            const idx = mappings.findIndex((m) => m.mappingId === mappingId);
            if (idx === -1) {
                return [...mappings, mapping];
            }
            const updated = [...mappings];
            updated[idx] = mapping;
            return updated;
        });
        if (!writeResult.ok) {
            return this.sendJson(res, 400, {
                ok: false,
                error: writeResult.error,
                ...(writeResult.errorCode ? { errorCode: writeResult.errorCode } : {}),
            });
        }
        if (created) {
            const reloadResult = await this.invokeReload();
            if (!reloadResult.ok) {
                console.warn(`[ManagementApi] upsert 新建 mapping "${mappingId}" 已写入但热重载失败: ${reloadResult.error}`);
                return this.sendJson(res, 201, {
                    ok: true,
                    created: true,
                    reloadOk: false,
                    message: `mapping "${mappingId}" 已保存`,
                    warning: `热重载未完全生效: ${reloadResult.error}`,
                    warnings: saveWarnings,
                    mapping: this.mappingSummary(mapping),
                });
            }
            let syncTriggered = false;
            if (mapping.enabled && (0, config_1.isMappingEffectiveEnabled)(mapping, reloadResult.config.mappings)) {
                this.opts.getScheduler().triggerMapping(mappingId);
                syncTriggered = true;
                console.log(`[ManagementApi] upsert 新建 mapping "${mappingId}"，已触发首次同步`);
            }
            else {
                console.log(`[ManagementApi] upsert 新建 mapping: ${mappingId}`);
            }
            return this.sendJson(res, 201, {
                ok: true,
                created: true,
                reloadOk: true,
                syncTriggered,
                message: saveWarnings.length
                    ? `mapping "${mappingId}" 已保存（因 localRoot 冲突已自动禁用）`
                    : `mapping "${mappingId}" 已创建并生效`,
                warnings: saveWarnings,
                mapping: this.mappingSummary(mapping),
            });
        }
        const changedFields = Object.keys(bodyObj).filter((k) => JSON.stringify(existingMapping[k]) !== JSON.stringify(mapping[k]));
        if (changedFields.length === 0) {
            return this.sendJson(res, 200, {
                ok: true,
                created: false,
                message: `mapping "${mappingId}" 无字段发生实际变化，跳过重载`,
                changed: [],
            });
        }
        const changedIdentityFields = changedFields.filter((f) => IDENTITY_FIELDS.includes(f));
        if (changedIdentityFields.length > 0) {
            this.opts.getScheduler().resetMappingState(mappingId);
            console.log(`[ManagementApi] 身份字段已变更 [${changedIdentityFields.join(', ')}]，已重置 mapping "${mappingId}" 的同步状态`);
        }
        const reloadResult = await this.invokeReload();
        if (!reloadResult.ok) {
            console.warn(`[ManagementApi] upsert 更新 mapping "${mappingId}" 已写入但热重载失败: ${reloadResult.error}`);
            return this.sendJson(res, 200, {
                ok: true,
                created: false,
                reloadOk: false,
                message: `mapping "${mappingId}" 已保存`,
                warning: `热重载未完全生效: ${reloadResult.error}`,
                changed: changedFields,
                warnings: saveWarnings,
                mapping: this.mappingSummary(mapping),
            });
        }
        const responseWarnings = [...saveWarnings];
        if (changedIdentityFields.length > 0) {
            responseWarnings.push(`身份字段 [${changedIdentityFields.join(', ')}] 已变更，同步状态已清除，下次同步将执行全量对账`);
        }
        console.log(`[ManagementApi] upsert 更新 mapping: ${mappingId}，变更字段: [${changedFields.join(', ')}]`);
        this.sendJson(res, 200, {
            ok: true,
            created: false,
            reloadOk: true,
            message: saveWarnings.length
                ? `mapping "${mappingId}" 已保存（因 localRoot 冲突已自动禁用）`
                : `mapping "${mappingId}" 已更新并生效`,
            changed: changedFields,
            warnings: responseWarnings,
            mapping: this.mappingSummary(mapping),
        });
    }
    async handleDeleteMapping(res, mappingId) {
        const writeResult = this.modifyConfigMappings((mappings) => {
            if (!mappings.some((m) => m.mappingId === mappingId)) {
                throw new Error(`未找到 mapping "${mappingId}"`);
            }
            return mappings.filter((m) => m.mappingId !== mappingId);
        });
        if (!writeResult.ok) {
            const status = writeResult.error.includes('未找到') ? 404 : 400;
            return this.sendJson(res, status, { ok: false, error: writeResult.error });
        }
        const reloadResult = await this.invokeReload();
        if (!reloadResult.ok) {
            console.warn(`[ManagementApi] mapping "${mappingId}" 已从 config.json 删除，但热重载失败: ${reloadResult.error}`);
            return this.sendJson(res, 200, {
                ok: true,
                reloadOk: false,
                message: `mapping "${mappingId}" 已从配置文件删除`,
                warning: `热重载未完全生效: ${reloadResult.error}。请继续删除其余冲突项；若仍异常可重启服务。`,
            });
        }
        console.log(`[ManagementApi] 删除 mapping: ${mappingId}`);
        this.sendJson(res, 200, { ok: true, reloadOk: true, message: `mapping "${mappingId}" 已删除` });
    }
    /**
     * POST /mappings/disable-by-local-prefix
     * 将 localRoot 位于给定前缀下的所有 mapping 设为 enabled=false。
     */
    async handleDisableByLocalPrefix(req, res) {
        let body;
        try {
            body = await this.readBody(req);
        }
        catch (e) {
            return this.sendJson(res, 400, {
                ok: false,
                error: `请求体解析失败: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            return this.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
        }
        const rawPrefix = body.localPathPrefix;
        if (typeof rawPrefix !== 'string' || !rawPrefix.trim()) {
            return this.sendJson(res, 400, {
                ok: false,
                error: 'localPathPrefix 必须是非空字符串',
            });
        }
        const localPathPrefix = rawPrefix.trim();
        const resolvedPrefix = (0, config_1.normalizeLocalRootPath)(localPathPrefix);
        let fileMappings;
        try {
            fileMappings = (0, config_1.readMappingsFromConfigFile)(this.opts.configPath);
        }
        catch (e) {
            return this.sendJson(res, 500, {
                ok: false,
                error: `读取 config.json mappings 失败: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
        const matched = fileMappings.filter((m) => (0, config_1.isLocalRootUnderPrefix)(m.localRoot, localPathPrefix));
        const alreadyDisabled = matched.filter((m) => !m.enabled).map((m) => m.mappingId);
        const toDisable = matched.filter((m) => m.enabled).map((m) => m.mappingId);
        if (matched.length === 0) {
            return this.sendJson(res, 200, {
                ok: true,
                reloadOk: true,
                unchanged: true,
                localPathPrefix,
                resolvedPrefix,
                matched: 0,
                disabled: [],
                alreadyDisabled: [],
                message: `未找到 localRoot 位于前缀 "${resolvedPrefix}" 下的 mapping`,
            });
        }
        if (toDisable.length === 0) {
            return this.sendJson(res, 200, {
                ok: true,
                reloadOk: true,
                unchanged: true,
                localPathPrefix,
                resolvedPrefix,
                matched: matched.length,
                disabled: [],
                alreadyDisabled,
                message: `匹配到 ${matched.length} 条 mapping，均已是禁用状态`,
            });
        }
        const disableSet = new Set(toDisable);
        const writeResult = this.modifyConfigMappings((mappings) => mappings.map((m) => (disableSet.has(m.mappingId) ? { ...m, enabled: false } : m)));
        if (!writeResult.ok) {
            return this.sendJson(res, 400, {
                ok: false,
                error: writeResult.error,
                ...(writeResult.errorCode ? { errorCode: writeResult.errorCode } : {}),
            });
        }
        const reloadResult = await this.invokeReload();
        if (!reloadResult.ok) {
            console.warn(`[ManagementApi] 前缀禁用已写入 config.json，但热重载失败: ${reloadResult.error}`);
            return this.sendJson(res, 200, {
                ok: true,
                reloadOk: false,
                localPathPrefix,
                resolvedPrefix,
                matched: matched.length,
                disabled: toDisable,
                alreadyDisabled,
                message: `已禁用 ${toDisable.length} 条 mapping`,
                warning: `热重载未完全生效: ${reloadResult.error}`,
            });
        }
        console.log(`[ManagementApi] 按前缀禁用 localRoot under "${resolvedPrefix}": disabled=[${toDisable.join(', ')}]`);
        this.sendJson(res, 200, {
            ok: true,
            reloadOk: true,
            localPathPrefix,
            resolvedPrefix,
            matched: matched.length,
            disabled: toDisable,
            alreadyDisabled,
            message: `已禁用 ${toDisable.length} 条 mapping（匹配 ${matched.length}，其中已禁用 ${alreadyDisabled.length}）`,
        });
    }
    async handleSetMappingEnabled(res, mappingId, enabled) {
        let fileMappings;
        try {
            fileMappings = (0, config_1.readMappingsFromConfigFile)(this.opts.configPath);
        }
        catch (e) {
            return this.sendJson(res, 500, {
                ok: false,
                error: `读取 config.json mappings 失败: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
        const idx = fileMappings.findIndex((m) => m.mappingId === mappingId);
        if (idx === -1) {
            return this.sendJson(res, 404, {
                ok: false,
                error: `未找到 mapping "${mappingId}"`,
                availableMappings: fileMappings.map((m) => m.mappingId),
            });
        }
        const existing = fileMappings[idx];
        if (existing.enabled === enabled) {
            return this.sendJson(res, 200, {
                ok: true,
                reloadOk: true,
                unchanged: true,
                enabled,
                message: `mapping "${mappingId}" 已是${enabled ? '启用' : '禁用'}状态`,
                mapping: this.mappingSummary(existing),
            });
        }
        let mapping = { ...existing, enabled };
        let saveWarnings = [];
        if (enabled) {
            const next = [...fileMappings];
            next[idx] = mapping;
            const downgraded = (0, config_1.downgradeMappingIfLocalRootConflict)(mapping, next);
            mapping = downgraded.mapping;
            if (downgraded.warning)
                saveWarnings = [downgraded.warning];
        }
        const finalMapping = mapping;
        const writeResult = this.modifyConfigMappings((mappings) => {
            const i = mappings.findIndex((m) => m.mappingId === mappingId);
            if (i === -1) {
                throw new Error(`未找到 mapping "${mappingId}"`);
            }
            const updated = [...mappings];
            updated[i] = finalMapping;
            return updated;
        });
        if (!writeResult.ok) {
            const status = writeResult.error.includes('未找到') ? 404 : 400;
            return this.sendJson(res, status, { ok: false, error: writeResult.error });
        }
        const reloadResult = await this.invokeReload();
        const actionLabel = mapping.enabled ? '启用' : '禁用';
        if (!reloadResult.ok) {
            console.warn(`[ManagementApi] mapping "${mappingId}" 已${actionLabel}但热重载失败: ${reloadResult.error}`);
            return this.sendJson(res, 200, {
                ok: true,
                reloadOk: false,
                enabled: mapping.enabled,
                message: `mapping "${mappingId}" 已${actionLabel}`,
                warning: `热重载未完全生效: ${reloadResult.error}`,
                warnings: saveWarnings,
                mapping: this.mappingSummary(mapping),
            });
        }
        console.log(`[ManagementApi] mapping "${mappingId}" 已${actionLabel}`);
        this.sendJson(res, 200, {
            ok: true,
            reloadOk: true,
            enabled: mapping.enabled,
            message: saveWarnings.length
                ? `mapping "${mappingId}" 已保存（因 localRoot 冲突未能启用）`
                : `mapping "${mappingId}" 已${actionLabel}`,
            warnings: saveWarnings,
            mapping: this.mappingSummary(mapping),
        });
    }
    handleResetMapping(res, mappingId) {
        const scheduler = this.opts.getScheduler();
        const config = scheduler.getConfig();
        const mapping = config.mappings.find((m) => m.mappingId === mappingId);
        if (!mapping) {
            return this.sendJson(res, 404, { ok: false, error: `未找到 mapping "${mappingId}"` });
        }
        scheduler.resetMappingState(mappingId);
        console.log(`[ManagementApi] 已重置 mapping "${mappingId}" 的同步状态（DB 已清空）`);
        this.sendJson(res, 200, { ok: true, message: `mapping "${mappingId}" 的同步状态已清空` });
    }
    // ==================== config.json 读写工具 ====================
    /**
     * 原子修改 config.json 根对象字段。
     */
    modifyConfigRoot(modifier) {
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(this.opts.configPath, 'utf-8'));
        }
        catch (e) {
            return { ok: false, error: `读取 config.json 失败: ${e instanceof Error ? e.message : String(e)}` };
        }
        try {
            raw = modifier(raw);
        }
        catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        return this.writeConfigRaw(raw);
    }
    /**
     * 原子修改 config.json 中的 mappings 数组。
     * 先写临时文件再重命名，防止写入中断导致配置损坏。
     */
    modifyConfigMappings(modifier) {
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(this.opts.configPath, 'utf-8'));
        }
        catch (e) {
            return { ok: false, error: `读取 config.json 失败: ${e instanceof Error ? e.message : String(e)}` };
        }
        const existingMappings = Array.isArray(raw.mappings)
            ? raw.mappings
            : [];
        let newMappings;
        try {
            newMappings = modifier(existingMappings);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const errorCode = e &&
                typeof e === 'object' &&
                'errorCode' in e &&
                typeof e.errorCode === 'string'
                ? e.errorCode
                : undefined;
            return errorCode ? { ok: false, error: msg, errorCode } : { ok: false, error: msg };
        }
        raw.mappings = newMappings;
        return this.writeConfigRaw(raw);
    }
    writeConfigRaw(raw) {
        const tmpPath = this.opts.configPath + '.tmp';
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
            fs.renameSync(tmpPath, this.opts.configPath);
        }
        catch (e) {
            try {
                fs.unlinkSync(tmpPath);
            }
            catch { /* ignore */ }
            return { ok: false, error: `写入 config.json 失败: ${e instanceof Error ? e.message : String(e)}` };
        }
        return { ok: true };
    }
    /** 解析 HTTP 请求体为 JSON 对象 */
    readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let totalBytes = 0;
            let settled = false;
            const onData = (chunk) => {
                if (settled)
                    return;
                totalBytes += chunk.length;
                if (totalBytes > MAX_MANAGEMENT_REQUEST_BODY_BYTES) {
                    settled = true;
                    chunks.length = 0;
                    req.off('data', onData);
                    req.resume();
                    reject(new Error(`请求体超过 ${MAX_MANAGEMENT_REQUEST_BODY_BYTES} bytes 上限`));
                    return;
                }
                chunks.push(chunk);
            };
            req.on('data', onData);
            req.on('end', () => {
                if (settled)
                    return;
                settled = true;
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
                }
                catch (e) {
                    reject(new Error('请求体不是合法 JSON'));
                }
            });
            req.on('error', (error) => {
                if (settled)
                    return;
                settled = true;
                reject(error);
            });
        });
    }
    /** 隐藏 appKey 敏感字段的 mapping 摘要 */
    mappingSummary(m, config) {
        const cfg = config ?? this.opts.getScheduler().getConfig();
        return {
            mappingId: m.mappingId,
            enabled: m.enabled,
            localRoot: m.localRoot,
            hasOwnAppKey: !!m.appKey,
            appKeyMasked: maskSecret(m.appKey),
            projectId: m.projectId,
            remoteRootFolderPath: m.remoteRootFolderPath,
            remoteRootFileId: m.remoteRootFileId,
            syncDirection: m.syncDirection,
            filePatterns: m.filePatterns,
            excludePatterns: m.excludePatterns,
            syncDotFiles: m.syncDotFiles,
            effectiveSyncDotFiles: (0, pathSyncScope_1.resolveSyncScopeOptions)(m, cfg).syncDotFiles,
            moveNameConflictStrategy: m.moveNameConflictStrategy,
            renameNameConflictStrategy: m.renameNameConflictStrategy,
            enableFileIndex: m.enableFileIndex,
            watchEnabled: m.watchEnabled,
            pushDebounceMs: m.pushDebounceMs,
            watchUsePolling: m.watchUsePolling,
            watchEnabledEffective: (0, watchHelpers_1.resolveWatchEnabled)(m, cfg),
            effectivePushDebounceMs: (0, watchHelpers_1.resolvePushDebounceMs)(m, cfg),
            effectiveWatchUsePolling: (0, watchHelpers_1.resolveWatchUsePolling)(m, cfg),
        };
    }
    // ==================== 工具方法 ====================
    /** 新建或变更 localRoot 时确保目录存在；失败则写 400 并返回 false */
    ensureLocalRootOrRespond(res, mapping) {
        const result = (0, ensureLocalRoot_1.ensureMappingLocalRoot)(mapping.localRoot);
        if (!result.ok) {
            this.sendJson(res, 400, { ok: false, error: result.error });
            return false;
        }
        console.log(`[ManagementApi][${mapping.mappingId}] localRoot 已就绪: ${result.path}`);
        return true;
    }
    /** 非敏感全局配置摘要（不含 appKey 明文） */
    globalConfigSummary(config, identity) {
        const id = identity ?? this.opts.getNodeIdentity();
        const centralUrl = config.centralManagerUrl?.trim() ?? '';
        return {
            serverUrl: config.serverUrl,
            appKeyMasked: maskSecret(config.appKey),
            syncDirection: config.syncDirection,
            autoSyncIntervalSec: config.autoSyncIntervalSec,
            fullReconcileIntervalSec: config.fullReconcileIntervalSec,
            stateDbPath: config.stateDbPath,
            maxConcurrentMappingsMode: config.maxConcurrentMappingsMode,
            maxConcurrentMappings: config.maxConcurrentMappings,
            effectiveMaxConcurrentMappings: (0, scheduler_1.resolveMaxConcurrentMappings)(config),
            maxRequestsPerMinute: config.maxRequestsPerMinute,
            rateLimitBurst: config.rateLimitBurst,
            rateLimitCooldownSec: config.rateLimitCooldownSec,
            downloadConcurrency: config.downloadConcurrency,
            uploadConcurrency: config.uploadConcurrency,
            maxFileSizeBytes: config.maxFileSizeBytes,
            startupJitterMaxSec: config.startupJitterMaxSec,
            managementPort: config.managementPort,
            managementHost: config.managementHost,
            watchEnabled: config.watchEnabled,
            pushDebounceMs: config.pushDebounceMs,
            watchUsePolling: config.watchUsePolling,
            syncDotFiles: config.syncDotFiles,
            centralManagerUrl: centralUrl,
            centralManagerEnabled: !!centralUrl,
            centralHeartbeatIntervalSec: config.centralHeartbeatIntervalSec,
            autoUpgradeEnabled: config.autoUpgradeEnabled !== false,
            autoUpgradeScript: config.autoUpgradeScript ?? '',
            nodeId: config.nodeId ?? '',
            nodeAdvertiseIp: config.nodeAdvertiseIp ?? '',
            effectiveNodeId: id.nodeId,
            effectiveAdvertiseIp: id.advertiseIp,
            nodeIdSource: id.source,
            localConfigVersion: config.localConfigVersion ?? 0,
        };
    }
    serveStaticFile(res, relativePath) {
        const safe = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
        if (safe.startsWith('..') || path.isAbsolute(safe)) {
            return this.sendJson(res, 400, { ok: false, error: '非法路径' });
        }
        const filePath = path.resolve(PUBLIC_DIR, safe);
        const publicRoot = path.resolve(PUBLIC_DIR);
        if (!filePath.startsWith(publicRoot + path.sep) && filePath !== publicRoot) {
            return this.sendJson(res, 400, { ok: false, error: '非法路径' });
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return this.sendJson(res, 404, { ok: false, error: '文件不存在' });
        }
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.png': 'image/png',
            '.woff2': 'font/woff2',
        };
        const contentType = mimeTypes[ext] ?? 'application/octet-stream';
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': data.length,
            'Cache-Control': 'no-cache',
        });
        res.end(data);
    }
    sendJson(res, status, body) {
        const json = JSON.stringify(body, null, 2);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(json),
        });
        res.end(json);
    }
}
exports.ManagementApi = ManagementApi;
//# sourceMappingURL=managementApi.js.map
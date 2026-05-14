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
const config_1 = require("./config");
const managementApiCredentials_1 = require("./managementApiCredentials");
/** 读取 package.json 里的版本号，失败则返回 'unknown' */
function readVersion() {
    try {
        const pkgPath = path.resolve(__dirname, '../package.json');
        const raw = fs.readFileSync(pkgPath, 'utf-8');
        const pkg = JSON.parse(raw);
        return pkg.version ?? 'unknown';
    }
    catch {
        return 'unknown';
    }
}
const VERSION = readVersion();
/**
 * HTTP 管理 API 服务
 *
 * 路由速览见类内 `start()` 日志。完整契约见仓库 **docs/MANAGEMENT_API.md**（给 AI / 自动化）；appKey 保存规则见 **src/managementApiCredentials.ts**。
 */
class ManagementApi {
    opts;
    startedAt = Date.now();
    server = null;
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
        this.server.listen(this.opts.port, this.opts.host, () => {
            console.log(`[ManagementApi] 已启动，监听 http://${this.opts.host}:${this.opts.port}`);
            console.log(`[ManagementApi] 可用接口:`);
            console.log(`  GET    /health`);
            console.log(`  GET    /status`);
            console.log(`  GET    /mappings`);
            console.log(`  POST   /mappings          新增 mapping`);
            console.log(`  PUT    /mappings/:id       更新 mapping`);
            console.log(`  DELETE /mappings/:id       删除 mapping`);
            console.log(`  POST   /sync/:mappingId`);
            console.log(`  POST   /sync  （触发所有）`);
            console.log(`  POST   /reload`);
        });
        this.server.on('error', (e) => {
            console.error('[ManagementApi] 服务器错误:', e);
        });
    }
    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
            console.log('[ManagementApi] 已停止');
        }
    }
    async handle(req, res) {
        const method = req.method ?? 'GET';
        const url = req.url ?? '/';
        const urlPath = url.split('?')[0];
        // GET /health
        if (method === 'GET' && urlPath === '/health') {
            return this.handleHealth(res);
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
        // GET /mappings
        if (method === 'GET' && urlPath === '/mappings') {
            return this.handleListMappings(res);
        }
        // POST /mappings  （新增）
        if (method === 'POST' && urlPath === '/mappings') {
            return this.handleCreateMapping(req, res);
        }
        // PUT /mappings/:mappingId  （更新）
        const putMatch = urlPath.match(/^\/mappings\/(.+)$/);
        if (method === 'PUT' && putMatch) {
            return this.handleUpdateMapping(req, res, decodeURIComponent(putMatch[1]));
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
        this.sendJson(res, 200, {
            ok: true,
            version: VERSION,
            pid: process.pid,
            uptime: Math.floor((Date.now() - this.startedAt) / 1000),
            startedAt: new Date(this.startedAt).toISOString(),
            mappingCount: config.mappings.length,
            enabledMappingCount: enabledCount,
            nodeVersion: process.version,
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
                isSyncing: state.isSyncing,
                pendingSync: state.pendingSync,
                lastState: state.lastState,
            };
        }
        this.sendJson(res, 200, {
            version: VERSION,
            pid: process.pid,
            uptime: Math.floor((Date.now() - this.startedAt) / 1000),
            startedAt: new Date(this.startedAt).toISOString(),
            nodeVersion: process.version,
            config: {
                serverUrl: config.serverUrl,
                syncDirection: config.syncDirection,
                autoSyncIntervalSec: config.autoSyncIntervalSec,
                maxConcurrentMappings: config.maxConcurrentMappings,
                maxRequestsPerMinute: config.maxRequestsPerMinute,
                mappingCount: config.mappings.length,
                enabledMappingCount: config.mappings.filter((m) => m.enabled).length,
            },
            mappings,
        });
    }
    handleReload(res) {
        console.log('[ManagementApi] 收到 /reload 请求，重载配置...');
        const result = this.opts.onReload();
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
        const enabled = config.mappings.filter((m) => m.enabled);
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
        if (!mapping.enabled) {
            return this.sendJson(res, 400, {
                ok: false,
                error: `mapping "${mappingId}" 已禁用（enabled=false）`,
            });
        }
        scheduler.triggerMapping(mappingId);
        this.sendJson(res, 200, { ok: true, message: `已触发同步: ${mappingId}` });
    }
    // ==================== Mapping CRUD ====================
    handleListMappings(res) {
        const config = this.opts.getScheduler().getConfig();
        this.sendJson(res, 200, {
            ok: true,
            total: config.mappings.length,
            /** 根级全局 appKey 是否已配置（非空）。为 false 时，新建/更新 mapping 必须在请求体中带非空 appKey，见 docs/MANAGEMENT_API.md */
            hasGlobalAppKey: !!(config.appKey && config.appKey.trim()),
            mappings: config.mappings.map((m) => this.mappingSummary(m)),
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
        const existingIds = this.opts.getScheduler().getConfig().mappings.map((m) => m.mappingId);
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
        const reloadResult = this.opts.onReload();
        if (!reloadResult.ok) {
            return this.sendJson(res, 500, { ok: false, error: `mapping 已写入但重载失败: ${reloadResult.error}` });
        }
        console.log(`[ManagementApi] 新增 mapping: ${mapping.mappingId}`);
        this.sendJson(res, 201, {
            ok: true,
            message: `mapping "${mapping.mappingId}" 已创建并生效`,
            mapping: this.mappingSummary(mapping),
        });
    }
    async handleUpdateMapping(req, res, mappingId) {
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
        // 请求体中若携带了 mappingId，必须与 URL 一致
        const bodyObj = body;
        if ('mappingId' in bodyObj && bodyObj.mappingId !== mappingId) {
            return this.sendJson(res, 400, {
                ok: false,
                error: `请求体中的 mappingId "${bodyObj.mappingId}" 与 URL 中的 "${mappingId}" 不一致`,
            });
        }
        // 身份字段：这些字段定义了"同步什么"，改变后旧的 SQLite 状态全部作废
        const IDENTITY_FIELDS = [
            'localRoot', 'remoteRootFolderPath', 'remoteRootFileId', 'projectId', 'appKey',
        ];
        let mapping;
        let existingMapping;
        const writeResult = this.modifyConfigMappings((mappings) => {
            const idx = mappings.findIndex((m) => m.mappingId === mappingId);
            if (idx === -1) {
                throw new Error(`未找到 mapping "${mappingId}"，如需新增请使用 POST /mappings`);
            }
            // 部分合并：以现有记录为基础，只覆盖请求体中显式提供的字段
            existingMapping = mappings[idx];
            const merged = { ...existingMapping, ...bodyObj, mappingId };
            mapping = (0, config_1.validateMapping)(merged, 0, '<API 请求>');
            const cred = (0, managementApiCredentials_1.getMappingCredentialsViolation)(this.opts.getScheduler().getConfig(), mapping);
            if (cred) {
                const err = new Error(cred.error);
                err.errorCode = cred.errorCode;
                throw err;
            }
            const updated = [...mappings];
            updated[idx] = mapping;
            return updated;
        });
        if (!writeResult.ok) {
            const status = writeResult.error.includes('未找到') ? 404 : 400;
            return this.sendJson(res, status, {
                ok: false,
                error: writeResult.error,
                ...(writeResult.errorCode ? { errorCode: writeResult.errorCode } : {}),
            });
        }
        // 检测实际发生了哪些变化
        const changedFields = Object.keys(bodyObj).filter((k) => JSON.stringify(existingMapping[k]) !== JSON.stringify(mapping[k]));
        // 无实际变化：直接返回，不触发 reload
        if (changedFields.length === 0) {
            // 回滚刚才写入的文件（内容未变，但避免无谓的 mtime 更新）
            return this.sendJson(res, 200, {
                ok: true,
                message: `mapping "${mappingId}" 无字段发生实际变化，跳过重载`,
                changed: [],
            });
        }
        // 身份字段有变化：在旧 scheduler（DB 连接仍开着）上重置同步状态
        const changedIdentityFields = changedFields.filter((f) => IDENTITY_FIELDS.includes(f));
        if (changedIdentityFields.length > 0) {
            this.opts.getScheduler().resetMappingState(mappingId);
            console.log(`[ManagementApi] 身份字段已变更 [${changedIdentityFields.join(', ')}]，已重置 mapping "${mappingId}" 的同步状态`);
        }
        const reloadResult = this.opts.onReload();
        if (!reloadResult.ok) {
            return this.sendJson(res, 500, { ok: false, error: `mapping 已写入但重载失败: ${reloadResult.error}` });
        }
        console.log(`[ManagementApi] 更新 mapping: ${mappingId}，变更字段: [${changedFields.join(', ')}]`);
        this.sendJson(res, 200, {
            ok: true,
            message: `mapping "${mappingId}" 已更新并生效`,
            changed: changedFields,
            ...(changedIdentityFields.length > 0 && {
                warnings: [
                    `身份字段 [${changedIdentityFields.join(', ')}] 已变更，同步状态已清除，下次同步将执行全量对账`,
                ],
            }),
            mapping: this.mappingSummary(mapping),
        });
    }
    handleDeleteMapping(res, mappingId) {
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
        const reloadResult = this.opts.onReload();
        if (!reloadResult.ok) {
            return this.sendJson(res, 500, { ok: false, error: `mapping 已删除但重载失败: ${reloadResult.error}` });
        }
        console.log(`[ManagementApi] 删除 mapping: ${mappingId}`);
        this.sendJson(res, 200, { ok: true, message: `mapping "${mappingId}" 已删除` });
    }
    // ==================== config.json 读写工具 ====================
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
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
                }
                catch (e) {
                    reject(new Error('请求体不是合法 JSON'));
                }
            });
            req.on('error', reject);
        });
    }
    /** 隐藏 appKey 敏感字段的 mapping 摘要 */
    mappingSummary(m) {
        return {
            mappingId: m.mappingId,
            enabled: m.enabled,
            localRoot: m.localRoot,
            hasOwnAppKey: !!m.appKey,
            projectId: m.projectId,
            remoteRootFolderPath: m.remoteRootFolderPath,
            remoteRootFileId: m.remoteRootFileId,
            syncDirection: m.syncDirection,
            filePatterns: m.filePatterns,
            excludePatterns: m.excludePatterns,
        };
    }
    // ==================== 工具方法 ====================
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
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
exports.loadConfig = loadConfig;
exports.validateMapping = validateMapping;
exports.generateUniqueMappingId = generateUniqueMappingId;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const constants_1 = require("./constants");
const DEFAULT_CONFIG_PATH = './config.json';
/**
 * 从 JSON 文件加载并验证配置。
 * @param configPath 配置文件路径（默认 ./config.json）
 */
function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
    const absPath = path.resolve(configPath);
    if (!fs.existsSync(absPath)) {
        throw new Error(`配置文件不存在: ${absPath}`);
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
    }
    catch (e) {
        throw new Error(`配置文件解析失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    return validateConfig(raw, absPath);
}
function validateConfig(raw, filePath) {
    if (typeof raw !== 'object' || raw === null) {
        throw new Error(`配置文件内容必须是 JSON 对象: ${filePath}`);
    }
    const obj = raw;
    // 必填字段
    assertString(obj, 'serverUrl', filePath);
    const rawAppKey = obj.appKey;
    const globalAppKey = typeof rawAppKey === 'string' && rawAppKey.trim() !== '' ? rawAppKey.trim() : undefined;
    if (!Array.isArray(obj.mappings)) {
        throw new Error(`配置 "mappings" 必须是数组: ${filePath}`);
    }
    const syncDirection = obj.syncDirection ?? 'bidirectional';
    if (!['bidirectional', 'push', 'pull'].includes(syncDirection)) {
        throw new Error(`配置 "syncDirection" 必须是 "bidirectional" | "push" | "pull": ${filePath}`);
    }
    const mappings = obj.mappings.map((m, idx) => validateMapping(m, idx, filePath));
    // 校验同一 localRoot 不映射到多个云端根
    const localRootSet = new Map();
    for (const m of mappings) {
        const norm = path.resolve(m.localRoot);
        if (localRootSet.has(norm)) {
            throw new Error(`配置错误: localRoot "${m.localRoot}" 被多个 mapping 使用（mappingId: ${localRootSet.get(norm)} 和 ${m.mappingId}），可能引起回环`);
        }
        localRootSet.set(norm, m.mappingId);
    }
    return {
        serverUrl: obj.serverUrl,
        ...(globalAppKey !== undefined ? { appKey: globalAppKey } : {}),
        syncDirection: syncDirection,
        autoSyncIntervalSec: typeof obj.autoSyncIntervalSec === 'number' ? obj.autoSyncIntervalSec : 60,
        stateDbPath: typeof obj.stateDbPath === 'string' ? obj.stateDbPath : constants_1.DEFAULT_DB_PATH,
        maxConcurrentMappings: typeof obj.maxConcurrentMappings === 'number'
            ? obj.maxConcurrentMappings
            : constants_1.DEFAULT_MAX_CONCURRENT_MAPPINGS,
        maxRequestsPerMinute: typeof obj.maxRequestsPerMinute === 'number'
            ? obj.maxRequestsPerMinute
            : constants_1.DEFAULT_MAX_REQUESTS_PER_MINUTE,
        rateLimitBurst: typeof obj.rateLimitBurst === 'number' ? obj.rateLimitBurst : constants_1.DEFAULT_RATE_LIMIT_BURST,
        rateLimitCooldownSec: typeof obj.rateLimitCooldownSec === 'number'
            ? obj.rateLimitCooldownSec
            : constants_1.RATE_LIMIT_COOLDOWN_MS / 1000,
        downloadConcurrency: typeof obj.downloadConcurrency === 'number' ? obj.downloadConcurrency : constants_1.DOWNLOAD_CONCURRENCY,
        uploadConcurrency: typeof obj.uploadConcurrency === 'number' ? obj.uploadConcurrency : constants_1.UPLOAD_CONCURRENCY,
        startupJitterMaxSec: typeof obj.startupJitterMaxSec === 'number'
            ? obj.startupJitterMaxSec
            : constants_1.STARTUP_JITTER_MAX_MS / 1000,
        managementPort: typeof obj.managementPort === 'number' ? obj.managementPort : 9090,
        managementHost: typeof obj.managementHost === 'string' ? obj.managementHost : '127.0.0.1',
        mappings,
    };
}
function validateMapping(raw, idx, filePath) {
    if (typeof raw !== 'object' || raw === null) {
        throw new Error(`mappings[${idx}] 必须是对象: ${filePath}`);
    }
    const m = raw;
    const loc = `mappings[${idx}]`;
    assertString(m, 'mappingId', filePath, loc);
    assertString(m, 'localRoot', filePath, loc);
    const hasFileId = typeof m.remoteRootFileId === 'string' && m.remoteRootFileId.trim() !== '';
    const hasFolderPath = typeof m.remoteRootFolderPath === 'string' && m.remoteRootFolderPath.trim() !== '';
    // 两者均不填时表示同步 projectId 空间的根目录，合法。
    if (m.enabled !== undefined && typeof m.enabled !== 'boolean') {
        throw new Error(`${loc}.enabled 必须是 boolean: ${filePath}`);
    }
    const filePatterns = Array.isArray(m.filePatterns)
        ? m.filePatterns
        : constants_1.DEFAULT_FILE_PATTERNS;
    const excludePatterns = Array.isArray(m.excludePatterns)
        ? m.excludePatterns
        : constants_1.DEFAULT_EXCLUDE_PATTERNS;
    const mappingAppKey = typeof m.appKey === 'string' && m.appKey.trim()
        ? m.appKey.trim()
        : undefined;
    const validDirections = ['bidirectional', 'push', 'pull'];
    const rawDir = m.syncDirection;
    if (rawDir !== undefined && !validDirections.includes(rawDir)) {
        throw new Error(`${loc}.syncDirection 必须是 "bidirectional" | "push" | "pull": ${filePath}`);
    }
    const mappingSyncDirection = rawDir && validDirections.includes(rawDir)
        ? rawDir
        : undefined;
    return {
        mappingId: m.mappingId,
        enabled: typeof m.enabled === 'boolean' ? m.enabled : true,
        localRoot: m.localRoot,
        appKey: mappingAppKey,
        projectId: typeof m.projectId === 'string' ? m.projectId : undefined,
        remoteRootFileId: hasFileId ? m.remoteRootFileId : undefined,
        remoteRootFolderPath: hasFolderPath ? m.remoteRootFolderPath : undefined,
        filePatterns,
        excludePatterns,
        syncDirection: mappingSyncDirection,
    };
}
/**
 * 为 POST /mappings 生成不与现有列表冲突的 mappingId。
 */
function generateUniqueMappingId(existingIds) {
    const used = new Set(existingIds);
    for (let n = 0; n < 64; n++) {
        const id = `map-${(0, crypto_1.randomBytes)(8).toString('hex')}`;
        if (!used.has(id))
            return id;
    }
    throw new Error('无法自动生成唯一 mappingId，请在请求体中显式指定 mappingId');
}
function assertString(obj, key, filePath, prefix) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] !== 'string' || !obj[key].trim()) {
        throw new Error(`配置 "${label}" 必须是非空字符串: ${filePath}`);
    }
}
//# sourceMappingURL=config.js.map
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
exports.DOWNLOAD_URL_REWRITE_TTL_MS = exports.DOWNLOAD_URL_REWRITE_FILE_NAME = void 0;
exports.resolveDownloadUrlRewritePath = resolveDownloadUrlRewritePath;
exports.rewriteDownloadUrl = rewriteDownloadUrl;
exports.resetDownloadUrlRewriteCache = resetDownloadUrlRewriteCache;
exports.getDownloadUrlRewriteDiskReadCount = getDownloadUrlRewriteDiskReadCount;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** 运维侧独立配置文件名（与 config.json 同级，不随自动升级覆盖） */
exports.DOWNLOAD_URL_REWRITE_FILE_NAME = 'download-url-rewrites.json';
/** 默认缓存 TTL：5 分钟；到期后才 stat/必要时重读 */
exports.DOWNLOAD_URL_REWRITE_TTL_MS = 5 * 60 * 1000;
let cache = null;
/** 实际读盘次数（含 JSON 解析）；测试可观测负缓存是否生效 */
let diskReadCount = 0;
function defaultProjectRoot() {
    return path.resolve(__dirname, '..');
}
/** 默认路径：项目根目录下的 download-url-rewrites.json */
function resolveDownloadUrlRewritePath(projectRoot) {
    return path.resolve(projectRoot ?? defaultProjectRoot(), exports.DOWNLOAD_URL_REWRITE_FILE_NAME);
}
function normalizeOrigin(raw) {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed)
        return null;
    try {
        return new URL(trimmed).origin;
    }
    catch {
        return null;
    }
}
function parseRulesFromRaw(raw, filePath) {
    if (!Array.isArray(raw)) {
        console.warn(`[DownloadUrlRewrite] ${filePath} 根节点必须是数组，已忽略`);
        return [];
    }
    const rules = [];
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            console.warn(`[DownloadUrlRewrite] 第 ${i} 条规则格式无效，已跳过`);
            continue;
        }
        const obj = item;
        if (typeof obj.from !== 'string' || typeof obj.to !== 'string') {
            console.warn(`[DownloadUrlRewrite] 第 ${i} 条规则缺少 from/to 字符串，已跳过`);
            continue;
        }
        const fromOrigin = normalizeOrigin(obj.from);
        const toOrigin = normalizeOrigin(obj.to);
        if (!fromOrigin || !toOrigin) {
            console.warn(`[DownloadUrlRewrite] 第 ${i} 条规则 from/to 不是合法 URL，已跳过`);
            continue;
        }
        if (fromOrigin === toOrigin)
            continue;
        rules.push({ fromOrigin, toOrigin });
    }
    return rules;
}
/** 仅在确认文件存在且 mtime 变化时调用；diskReadCount 统计 readFileSync 次数 */
function readRulesFromDisk(filePath) {
    diskReadCount++;
    try {
        const text = fs.readFileSync(filePath, 'utf-8').trim();
        if (!text) {
            console.log(`[DownloadUrlRewrite] ${filePath} 为空，使用空规则（已缓存）`);
            return [];
        }
        const rules = parseRulesFromRaw(JSON.parse(text), filePath);
        console.log(`[DownloadUrlRewrite] 已加载 ${rules.length} 条域名替换规则: ${filePath}`);
        return rules;
    }
    catch (e) {
        console.warn(`[DownloadUrlRewrite] 读取失败，使用空规则（已缓存）: ${filePath} — ` +
            `${e instanceof Error ? e.message : String(e)}`);
        return [];
    }
}
function getRules(opts) {
    const filePath = opts?.filePath ?? resolveDownloadUrlRewritePath();
    const now = opts?.now ?? Date.now();
    const ttlMs = opts?.ttlMs ?? exports.DOWNLOAD_URL_REWRITE_TTL_MS;
    if (cache && cache.filePath === filePath && now - cache.loadedAt < ttlMs) {
        return cache.rules;
    }
    let mtimeMs = null;
    try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
    }
    catch {
        mtimeMs = null;
    }
    // TTL 到期但 mtime 未变（含仍不存在）：只刷新 loadedAt，不读内容
    if (cache && cache.filePath === filePath && cache.mtimeMs === mtimeMs) {
        cache.loadedAt = now;
        return cache.rules;
    }
    const rules = mtimeMs == null ? [] : readRulesFromDisk(filePath);
    cache = { filePath, rules, mtimeMs, loadedAt: now };
    if (mtimeMs == null) {
        console.log(`[DownloadUrlRewrite] 未找到配置文件，使用空规则（已缓存 ${ttlMs / 1000}s）: ${filePath}`);
    }
    return cache.rules;
}
/**
 * 若配置了匹配规则，将 downloadUrl 的 origin 替换为 to；否则原样返回。
 * 规则文件经 TTL + mtime 缓存；文件缺失也会负缓存，避免每次下载读盘。
 */
function rewriteDownloadUrl(url, opts) {
    if (!url)
        return url;
    const rules = getRules(opts);
    if (rules.length === 0)
        return url;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return url;
    }
    for (const rule of rules) {
        if (parsed.origin === rule.fromOrigin) {
            return rule.toOrigin + parsed.pathname + parsed.search + parsed.hash;
        }
    }
    return url;
}
/** 测试用：清空内存缓存 */
function resetDownloadUrlRewriteCache() {
    cache = null;
    diskReadCount = 0;
}
/** 测试用：实际读盘（含解析）次数 */
function getDownloadUrlRewriteDiskReadCount() {
    return diskReadCount;
}
//# sourceMappingURL=downloadUrlRewrite.js.map
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
exports.ensureMappingLocalRoot = ensureMappingLocalRoot;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * 确保 mapping 的 localRoot 目录在磁盘上存在（recursive mkdir）。
 * 新建 mapping 或热重载启动 watcher 前调用，避免目录尚未创建导致 chokidar 跳过。
 */
function ensureMappingLocalRoot(localRoot) {
    const trimmed = localRoot.trim();
    if (!trimmed) {
        return { ok: false, error: 'localRoot 不能为空' };
    }
    const resolved = path.resolve(trimmed);
    try {
        fs.mkdirSync(resolved, { recursive: true });
        return { ok: true, path: resolved };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `无法创建 localRoot 目录 "${resolved}": ${msg}` };
    }
}
//# sourceMappingURL=ensureLocalRoot.js.map
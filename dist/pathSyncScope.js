"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveSyncScopeOptions = resolveSyncScopeOptions;
exports.pathHasDotSegment = pathHasDotSegment;
exports.shouldSkipDotEntryName = shouldSkipDotEntryName;
exports.isInSyncScope = isInSyncScope;
exports.isRemotePathInSyncScope = isRemotePathInSyncScope;
const micromatch_1 = __importDefault(require("micromatch"));
const constants_1 = require("./constants");
const pathSanitize_1 = require("./pathSanitize");
/** 解析 mapping 级 + 全局级 syncDotFiles 与 glob 默认值 */
function resolveSyncScopeOptions(mapping, globalConfig) {
    return {
        filePatterns: mapping.filePatterns ?? constants_1.DEFAULT_FILE_PATTERNS,
        excludePatterns: mapping.excludePatterns ?? constants_1.DEFAULT_EXCLUDE_PATTERNS,
        syncDotFiles: mapping.syncDotFiles ?? globalConfig?.syncDotFiles ?? constants_1.DEFAULT_SYNC_DOT_FILES,
    };
}
/** 相对路径是否包含以 `.` 开头的路径段（如 `notes/.env`、`/.git/config`） */
function pathHasDotSegment(relPath) {
    const norm = (0, pathSanitize_1.normalizeSeparator)(relPath).replace(/^\/+/, '').replace(/\/+$/, '');
    if (!norm)
        return false;
    return norm.split('/').some((seg) => seg.length > 0 && seg.startsWith('.'));
}
/** readdir 阶段：是否因点文件名/目录名跳过（未进入路径拼接） */
function shouldSkipDotEntryName(name, syncDotFiles) {
    return !syncDotFiles && name.startsWith('.');
}
/**
 * 判断相对路径是否在同步范围内。
 * - 目录：仅检查点路径规则 + excludePatterns（不要求匹配 filePatterns）
 * - 文件：点路径规则 + excludePatterns + filePatterns
 */
function isInSyncScope(relPath, scope, kind) {
    const norm = (0, pathSanitize_1.canonicalizeRelativeSyncPath)((0, pathSanitize_1.normalizeSeparator)(relPath));
    if (!norm)
        return kind === 'directory';
    if (!scope.syncDotFiles && pathHasDotSegment(norm))
        return false;
    if (kind === 'directory') {
        const relDir = norm.endsWith('/') ? norm : `${norm}/`;
        return !micromatch_1.default.isMatch(relDir, scope.excludePatterns);
    }
    if (micromatch_1.default.isMatch(norm, scope.excludePatterns))
        return false;
    return micromatch_1.default.isMatch(norm, scope.filePatterns);
}
/** 远端 list 结果是否与本地 walk 使用相同范围规则 */
function isRemotePathInSyncScope(relPath, scope) {
    return isInSyncScope(relPath, scope, 'file');
}
//# sourceMappingURL=pathSyncScope.js.map
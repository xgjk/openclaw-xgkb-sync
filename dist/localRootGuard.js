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
exports.inspectLocalRoot = inspectLocalRoot;
exports.isLocalWorkspaceAnomaly = isLocalWorkspaceAnomaly;
exports.evaluateRemoteDeleteGuard = evaluateRemoteDeleteGuard;
exports.hasMappingSyncHistory = hasMappingSyncHistory;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const constants_1 = require("./constants");
/**
 * 同步开始前检查 localRoot 是否可用于扫描。
 * 不自动 mkdir——目录缺失视为异常，避免在空目录上继续对账删远端。
 */
function inspectLocalRoot(localRoot) {
    const trimmed = localRoot.trim();
    if (!trimmed) {
        return {
            ok: false,
            reason: 'empty_path',
            path: trimmed,
            detail: 'localRoot 不能为空',
        };
    }
    const resolved = path.resolve(trimmed);
    if (!fs.existsSync(resolved)) {
        return {
            ok: false,
            reason: 'missing',
            path: resolved,
            detail: `localRoot 不存在: ${resolved}`,
        };
    }
    let stat;
    try {
        stat = fs.statSync(resolved);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            reason: 'not_readable',
            path: resolved,
            detail: `无法访问 localRoot "${resolved}": ${msg}`,
        };
    }
    if (!stat.isDirectory()) {
        return {
            ok: false,
            reason: 'not_directory',
            path: resolved,
            detail: `localRoot 不是目录: ${resolved}`,
        };
    }
    try {
        fs.accessSync(resolved, fs.constants.R_OK);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            reason: 'not_readable',
            path: resolved,
            detail: `localRoot 不可读 "${resolved}": ${msg}`,
        };
    }
    return { ok: true, path: resolved };
}
/**
 * 本地工作区是否相对历史同步状态「异常偏空」。
 * 典型场景：工作空间迁移、挂载丢失、路径配错导致目录被清空。
 */
function isLocalWorkspaceAnomaly(localFileCount, knownRecordCount) {
    if (knownRecordCount < constants_1.LOCAL_ROOT_GUARD_MIN_KNOWN_FILES)
        return false;
    if (localFileCount === 0)
        return true;
    const dropRatio = (knownRecordCount - localFileCount) / knownRecordCount;
    return dropRatio >= constants_1.MASS_DELETE_LOCAL_DROP_RATIO;
}
/**
 * 在本地工作区异常偏空时，阻断批量 delete-remote，并改为从远端重新拉取。
 */
function evaluateRemoteDeleteGuard(input) {
    const inactive = {
        active: false,
        reason: '',
        recoveryOp: 'download-new',
    };
    const { localFileCount, knownRecordCount, plannedDeleteRemoteCount } = input;
    if (plannedDeleteRemoteCount === 0)
        return inactive;
    if (!isLocalWorkspaceAnomaly(localFileCount, knownRecordCount))
        return inactive;
    // 本地完全为空：任意 delete-remote 均视为误删风险
    if (localFileCount > 0 && plannedDeleteRemoteCount < constants_1.MASS_DELETE_REMOTE_BLOCK_COUNT) {
        return inactive;
    }
    const reason = localFileCount === 0
        ? `本地目录为空（0 个文件），但状态库仍有 ${knownRecordCount} 条记录；` +
            `已阻断 ${plannedDeleteRemoteCount} 项远端删除，改为从远端重新拉取`
        : `本地文件数骤降（${localFileCount}/${knownRecordCount}，降幅 ${Math.round(((knownRecordCount - localFileCount) / knownRecordCount) * 100)}%）；` +
            `已阻断 ${plannedDeleteRemoteCount} 项远端删除，改为从远端重新拉取`;
    return { active: true, reason, recoveryOp: 'download-new' };
}
/**
 * mapping 是否曾有过有效同步历史（用于区分「新建尚未同步」与「运行中根目录被删」）。
 */
function hasMappingSyncHistory(mappingState, fileRecordCount) {
    if (fileRecordCount > 0)
        return true;
    if (!mappingState)
        return false;
    if (mappingState.lastSuccessAt)
        return true;
    if (mappingState.lastSyncSince)
        return true;
    if (mappingState.resolvedRootFileId)
        return true;
    return false;
}
//# sourceMappingURL=localRootGuard.js.map
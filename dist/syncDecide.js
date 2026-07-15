"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decideSyncOp = decideSyncOp;
exports.shouldBlockDownloadForRemoteIdentity = shouldBlockDownloadForRemoteIdentity;
const constants_1 = require("./constants");
/**
 * 路径对账决策（纯函数，便于单测）。
 *
 * 产品规则：本地→知识库不做删除；本地删除后记 tombstone，后续不从 KB 拉回。
 */
function decideSyncOp(input) {
    const { path, local, remote, record, syncDirection, conflictStrategy, workspaceAnomaly, tombstonedRemoteFileIds, remoteFileIdOwners, } = input;
    const dir = syncDirection || 'bidirectional';
    // 无历史记录：首次碰到
    if (!record) {
        if (local && !remote)
            return dir === 'pull' ? 'skip' : 'upload-new';
        if (!local && remote) {
            // 已知 remoteFileId 已挂在其他路径（tombstone / 未完成的远端 rename）：禁止当新文件拉回
            if (remote.remoteFileId) {
                if (tombstonedRemoteFileIds.has(remote.remoteFileId))
                    return 'skip';
                const owner = remoteFileIdOwners.get(remote.remoteFileId);
                if (owner && owner.localPath !== path)
                    return 'skip';
            }
            return dir === 'push' ? 'skip' : 'download-new';
        }
        if (local && remote) {
            if (dir === 'pull')
                return 'download-update';
            if (dir === 'push')
                return 'upload-update';
            const conflictWinner = conflictStrategy ?? 'local-wins';
            return conflictWinner === 'local-wins' ? 'upload-update' : 'download-update';
        }
        return 'skip';
    }
    // ---- 本地删除 tombstone ----
    if (record.syncStatus === 'local-deleted') {
        if (!local)
            return 'skip';
        if (dir === 'pull')
            return 'clear-local-tombstone';
        return remote ? 'upload-update' : 'upload-new';
    }
    // 双端在本轮视图中均消失
    if (!local && !remote) {
        // 异常偏空时不写 tombstone，避免「挂载丢失」被永久记成用户删除
        if (workspaceAnomaly)
            return 'skip';
        return 'tombstone-local';
    }
    // 本地缺失，远端存在
    if (!local && remote) {
        // 异常偏空：不 tombstone、不拉回，等本地恢复后再对账
        if (workspaceAnomaly)
            return 'skip';
        return 'tombstone-local';
    }
    // 本地存在，远端缺失
    if (local && !remote) {
        if (dir === 'pull')
            return 'skip';
        const localChanged = local.mtime > (record.localMtime ?? 0) + constants_1.MTIME_TOLERANCE_MS;
        if (localChanged)
            return 'upload-new';
        const RECENTLY_SYNCED_THRESHOLD_MS = 10 * 60 * 1000;
        if (record.syncStatus === 'done' &&
            record.remoteFileId &&
            record.lastSyncAt &&
            Date.now() - record.lastSyncAt < RECENTLY_SYNCED_THRESHOLD_MS) {
            return 'skip';
        }
        return 'delete-local';
    }
    // 双端均存在
    if (local && remote) {
        const localChanged = local.mtime > (record.localMtime ?? 0) + constants_1.MTIME_TOLERANCE_MS;
        const remoteChanged = remote.mtime > (record.remoteMtime ?? 0) + constants_1.MTIME_TOLERANCE_MS;
        if (!localChanged && !remoteChanged)
            return 'skip';
        if (localChanged && !remoteChanged)
            return dir === 'pull' ? 'skip' : 'upload-update';
        if (!localChanged && remoteChanged)
            return dir === 'push' ? 'skip' : 'download-update';
        if (dir === 'pull')
            return 'download-update';
        if (dir === 'push')
            return 'upload-update';
        const conflictWinner = conflictStrategy ?? 'local-wins';
        return conflictWinner === 'local-wins' ? 'upload-update' : 'download-update';
    }
    return 'skip';
}
/**
 * 执行前再拦一道：下载计划不得命中 tombstone / 已归属其他路径的 remoteFileId。
 * 防止 decide 漏判或同轮计划互相干扰。
 */
function shouldBlockDownloadForRemoteIdentity(input) {
    const { path, remoteFileId, tombstonedRemoteFileIds, remoteFileIdOwners } = input;
    if (!remoteFileId)
        return false;
    if (tombstonedRemoteFileIds.has(remoteFileId))
        return true;
    const owner = remoteFileIdOwners.get(remoteFileId);
    return !!(owner && owner.localPath !== path);
}
//# sourceMappingURL=syncDecide.js.map
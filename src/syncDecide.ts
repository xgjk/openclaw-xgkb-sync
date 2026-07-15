import { MTIME_TOLERANCE_MS } from './constants';
import { FileState, LocalFileEntry, RemoteFileEntry, SyncOp } from './types';

export interface DecideSyncOpInput {
  path: string;
  local: LocalFileEntry | undefined;
  remote: RemoteFileEntry | undefined;
  record: FileState | undefined;
  /** push | pull | bidirectional */
  syncDirection: string;
  /** local-wins | remote-wins；仅双向冲突时使用 */
  conflictStrategy?: string | null;
  /**
   * 本地工作区相对历史记录异常偏空（迁移/挂载丢失等）。
   * 此时禁止批量写成 tombstone（否则恢复挂载后也无法对账），也禁止 download 拉回。
   */
  workspaceAnomaly: boolean;
  /** 已 tombstone 的 remoteFileId */
  tombstonedRemoteFileIds: ReadonlySet<string>;
  /** remoteFileId → 归属记录（含任意 syncStatus） */
  remoteFileIdOwners: ReadonlyMap<string, FileState>;
}

/**
 * 路径对账决策（纯函数，便于单测）。
 *
 * 产品规则：本地→知识库不做删除；本地删除后记 tombstone，后续不从 KB 拉回。
 */
export function decideSyncOp(input: DecideSyncOpInput): SyncOp {
  const {
    path,
    local,
    remote,
    record,
    syncDirection,
    conflictStrategy,
    workspaceAnomaly,
    tombstonedRemoteFileIds,
    remoteFileIdOwners,
  } = input;
  const dir = syncDirection || 'bidirectional';

  // 无历史记录：首次碰到
  if (!record) {
    if (local && !remote) return dir === 'pull' ? 'skip' : 'upload-new';
    if (!local && remote) {
      // 已知 remoteFileId 已挂在其他路径（tombstone / 未完成的远端 rename）：禁止当新文件拉回
      if (remote.remoteFileId) {
        if (tombstonedRemoteFileIds.has(remote.remoteFileId)) return 'skip';
        const owner = remoteFileIdOwners.get(remote.remoteFileId);
        if (owner && owner.localPath !== path) return 'skip';
      }
      return dir === 'push' ? 'skip' : 'download-new';
    }
    if (local && remote) {
      if (dir === 'pull') return 'download-update';
      if (dir === 'push') return 'upload-update';
      const conflictWinner = conflictStrategy ?? 'local-wins';
      return conflictWinner === 'local-wins' ? 'upload-update' : 'download-update';
    }
    return 'skip';
  }

  // ---- 本地删除 tombstone ----
  if (record.syncStatus === 'local-deleted') {
    if (!local) return 'skip';
    if (dir === 'pull') return 'clear-local-tombstone';
    return remote ? 'upload-update' : 'upload-new';
  }

  // 双端在本轮视图中均消失
  if (!local && !remote) {
    // 异常偏空时不写 tombstone，避免「挂载丢失」被永久记成用户删除
    if (workspaceAnomaly) return 'skip';
    return 'tombstone-local';
  }

  // 本地缺失，远端存在
  if (!local && remote) {
    // 异常偏空：不 tombstone、不拉回，等本地恢复后再对账
    if (workspaceAnomaly) return 'skip';
    return 'tombstone-local';
  }

  // 本地存在，远端缺失
  if (local && !remote) {
    if (dir === 'pull') return 'skip';
    const localChanged = local.mtime > (record.localMtime ?? 0) + MTIME_TOLERANCE_MS;
    if (localChanged) return 'upload-new';

    const RECENTLY_SYNCED_THRESHOLD_MS = 10 * 60 * 1000;
    if (
      record.syncStatus === 'done' &&
      record.remoteFileId &&
      record.lastSyncAt &&
      Date.now() - record.lastSyncAt < RECENTLY_SYNCED_THRESHOLD_MS
    ) {
      return 'skip';
    }
    return 'delete-local';
  }

  // 双端均存在
  if (local && remote) {
    const localChanged = local.mtime > (record.localMtime ?? 0) + MTIME_TOLERANCE_MS;
    const remoteChanged = remote.mtime > (record.remoteMtime ?? 0) + MTIME_TOLERANCE_MS;

    if (!localChanged && !remoteChanged) return 'skip';
    if (localChanged && !remoteChanged) return dir === 'pull' ? 'skip' : 'upload-update';
    if (!localChanged && remoteChanged) return dir === 'push' ? 'skip' : 'download-update';

    if (dir === 'pull') return 'download-update';
    if (dir === 'push') return 'upload-update';
    const conflictWinner = conflictStrategy ?? 'local-wins';
    return conflictWinner === 'local-wins' ? 'upload-update' : 'download-update';
  }

  return 'skip';
}

/**
 * 执行前再拦一道：下载计划不得命中 tombstone / 已归属其他路径的 remoteFileId。
 * 防止 decide 漏判或同轮计划互相干扰。
 */
export function shouldBlockDownloadForRemoteIdentity(input: {
  path: string;
  remoteFileId: string | undefined | null;
  tombstonedRemoteFileIds: ReadonlySet<string>;
  remoteFileIdOwners: ReadonlyMap<string, FileState>;
}): boolean {
  const { path, remoteFileId, tombstonedRemoteFileIds, remoteFileIdOwners } = input;
  if (!remoteFileId) return false;
  if (tombstonedRemoteFileIds.has(remoteFileId)) return true;
  const owner = remoteFileIdOwners.get(remoteFileId);
  return !!(owner && owner.localPath !== path);
}

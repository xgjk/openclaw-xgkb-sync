import { MTIME_TOLERANCE_MS } from './constants';
import { gateDownloadRetry } from './downloadRetryPolicy';
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
  /** 权限降级成 pull 时，双方均有本地变化则保留本地，避免静默覆盖待上传内容。 */
  protectLocalChanges?: boolean;
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
    protectLocalChanges = false,
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
      if (dir === 'pull') return protectLocalChanges ? 'skip' : 'download-update';
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
    // 下载失败记录应由调用方合成 remote 后再决策；此处兜底保留，勿 tombstone
    if (record.syncStatus === 'failed' && record.remoteFileId) return 'skip';
    return 'tombstone-local';
  }

  // 本地缺失，远端存在
  if (!local && remote) {
    // 异常偏空：不 tombstone、不拉回，等本地恢复后再对账
    if (workspaceAnomaly) return 'skip';
    // 下载失败留下的记录：继续按下载重试，勿误记 tombstone
    if (record.syncStatus === 'failed' && record.remoteFileId) {
      return dir === 'push' ? 'skip' : 'download-new';
    }
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

    if (dir === 'pull') return protectLocalChanges ? 'skip' : 'download-update';
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

export interface DownloadRetryGateApplication {
  op: SyncOp;
  /** proceed=照常下载；defer=未到点跳过；abandon=已达上限放弃；unaffected=非下载 op */
  gate: 'proceed' | 'defer' | 'abandon' | 'unaffected';
}

/**
 * 下载计划在入队前再过一遍重试门闸：退避未到期或已达最大次数则改为 skip。
 * defer/abandon 均不打接口；defer 应由调用方阻止水位推进。
 */
export function applyDownloadRetryGate(
  op: SyncOp,
  record: FileState | undefined,
  remote: RemoteFileEntry | undefined,
  now = Date.now(),
): DownloadRetryGateApplication {
  if (op !== 'download-new' && op !== 'download-update') {
    return { op, gate: 'unaffected' };
  }
  if (!remote) return { op, gate: 'proceed' };
  const gate = gateDownloadRetry({ record, remote, now });
  if (gate === 'proceed') return { op, gate };
  return { op: 'skip', gate };
}

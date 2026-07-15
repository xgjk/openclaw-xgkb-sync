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
export declare function decideSyncOp(input: DecideSyncOpInput): SyncOp;
/**
 * 执行前再拦一道：下载计划不得命中 tombstone / 已归属其他路径的 remoteFileId。
 * 防止 decide 漏判或同轮计划互相干扰。
 */
export declare function shouldBlockDownloadForRemoteIdentity(input: {
    path: string;
    remoteFileId: string | undefined | null;
    tombstonedRemoteFileIds: ReadonlySet<string>;
    remoteFileIdOwners: ReadonlyMap<string, FileState>;
}): boolean;
//# sourceMappingURL=syncDecide.d.ts.map
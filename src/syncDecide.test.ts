import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideSyncOp, shouldBlockDownloadForRemoteIdentity } from './syncDecide';
import { FileState, LocalFileEntry, RemoteFileEntry } from './types';

function local(path: string, mtime = 1000): LocalFileEntry {
  return { path, name: path.split('/').pop() ?? path, mtime, size: 1, dev: '1', ino: '1' };
}

function remote(path: string, remoteFileId: string, mtime = 1000): RemoteFileEntry {
  return {
    path,
    name: path.split('/').pop() ?? path,
    mtime,
    remoteFileId,
    remoteFolderId: 'folder',
  };
}

function record(
  path: string,
  overrides: Partial<FileState> = {},
): FileState {
  return {
    mappingId: 'm1',
    localPath: path,
    remoteFileId: 'rid-1',
    remoteFolderId: 'folder',
    localMtime: 1000,
    remoteMtime: 1000,
    contentHash: null,
    syncStatus: 'done',
    lastSyncAt: Date.now(),
    lastError: null,
    localDev: '1',
    localIno: '1',
    remoteRelativePath: path,
    ...overrides,
  };
}

const emptyIds = new Set<string>();
const emptyOwners = new Map<string, FileState>();

describe('decideSyncOp — 本地删除 tombstone', () => {
  it('本地缺 + 远端在 + 有记录 → tombstone-local（各方向）', () => {
    for (const syncDirection of ['push', 'pull', 'bidirectional']) {
      const op = decideSyncOp({
        path: 'a.md',
        local: undefined,
        remote: remote('a.md', 'rid-1'),
        record: record('a.md'),
        syncDirection,
        workspaceAnomaly: false,
        tombstonedRemoteFileIds: emptyIds,
        remoteFileIdOwners: emptyOwners,
      });
      assert.equal(op, 'tombstone-local', syncDirection);
    }
  });

  it('已 tombstone + 本地仍缺 → skip（绝不 download）', () => {
    for (const syncDirection of ['push', 'pull', 'bidirectional']) {
      const op = decideSyncOp({
        path: 'a.md',
        local: undefined,
        remote: remote('a.md', 'rid-1'),
        record: record('a.md', { syncStatus: 'local-deleted' }),
        syncDirection,
        workspaceAnomaly: false,
        tombstonedRemoteFileIds: new Set(['rid-1']),
        remoteFileIdOwners: emptyOwners,
      });
      assert.equal(op, 'skip', syncDirection);
    }
  });

  it('已 tombstone + 本地恢复：push/bidi 上传，pull 清标记', () => {
    assert.equal(
      decideSyncOp({
        path: 'a.md',
        local: local('a.md'),
        remote: remote('a.md', 'rid-1'),
        record: record('a.md', { syncStatus: 'local-deleted' }),
        syncDirection: 'bidirectional',
        workspaceAnomaly: false,
        tombstonedRemoteFileIds: new Set(['rid-1']),
        remoteFileIdOwners: emptyOwners,
      }),
      'upload-update',
    );
    assert.equal(
      decideSyncOp({
        path: 'a.md',
        local: local('a.md'),
        remote: remote('a.md', 'rid-1'),
        record: record('a.md', { syncStatus: 'local-deleted' }),
        syncDirection: 'pull',
        workspaceAnomaly: false,
        tombstonedRemoteFileIds: new Set(['rid-1']),
        remoteFileIdOwners: emptyOwners,
      }),
      'clear-local-tombstone',
    );
  });

  it('无 record 但 remoteFileId 命中 tombstone（远端 rename）→ skip', () => {
    const op = decideSyncOp({
      path: 'b.md',
      local: undefined,
      remote: remote('b.md', 'rid-1'),
      record: undefined,
      syncDirection: 'bidirectional',
      workspaceAnomaly: false,
      tombstonedRemoteFileIds: new Set(['rid-1']),
      remoteFileIdOwners: new Map([
        ['rid-1', record('a.md', { syncStatus: 'local-deleted' })],
      ]),
    });
    assert.equal(op, 'skip');
  });

  it('无 record 但 remoteFileId 归属其他路径（同轮未完成 rename）→ skip', () => {
    const op = decideSyncOp({
      path: 'b.md',
      local: undefined,
      remote: remote('b.md', 'rid-1'),
      record: undefined,
      syncDirection: 'bidirectional',
      workspaceAnomaly: false,
      tombstonedRemoteFileIds: emptyIds,
      remoteFileIdOwners: new Map([['rid-1', record('a.md')]]),
    });
    assert.equal(op, 'skip');
  });

  it('工作区异常偏空：双端都消失 → skip（不 tombstone）', () => {
    const op = decideSyncOp({
      path: 'a.md',
      local: undefined,
      remote: undefined,
      record: record('a.md'),
      syncDirection: 'bidirectional',
      workspaceAnomaly: true,
      tombstonedRemoteFileIds: emptyIds,
      remoteFileIdOwners: emptyOwners,
    });
    assert.equal(op, 'skip');
  });

  it('工作区异常偏空：本地缺+远端在 → skip（不 tombstone、不拉回）', () => {
    const op = decideSyncOp({
      path: 'a.md',
      local: undefined,
      remote: remote('a.md', 'rid-1'),
      record: record('a.md'),
      syncDirection: 'bidirectional',
      workspaceAnomaly: true,
      tombstonedRemoteFileIds: emptyIds,
      remoteFileIdOwners: emptyOwners,
    });
    assert.equal(op, 'skip');
  });

  it('真正的新远端文件（无归属）→ download-new', () => {
    const op = decideSyncOp({
      path: 'new.md',
      local: undefined,
      remote: remote('new.md', 'rid-new'),
      record: undefined,
      syncDirection: 'bidirectional',
      workspaceAnomaly: false,
      tombstonedRemoteFileIds: emptyIds,
      remoteFileIdOwners: emptyOwners,
    });
    assert.equal(op, 'download-new');
  });
});

describe('shouldBlockDownloadForRemoteIdentity', () => {
  it('拦截 tombstone fileId', () => {
    assert.equal(
      shouldBlockDownloadForRemoteIdentity({
        path: 'b.md',
        remoteFileId: 'rid-1',
        tombstonedRemoteFileIds: new Set(['rid-1']),
        remoteFileIdOwners: emptyOwners,
      }),
      true,
    );
  });

  it('拦截归属其他路径的 fileId', () => {
    assert.equal(
      shouldBlockDownloadForRemoteIdentity({
        path: 'b.md',
        remoteFileId: 'rid-1',
        tombstonedRemoteFileIds: emptyIds,
        remoteFileIdOwners: new Map([['rid-1', record('a.md')]]),
      }),
      true,
    );
  });

  it('同路径归属不拦截', () => {
    assert.equal(
      shouldBlockDownloadForRemoteIdentity({
        path: 'a.md',
        remoteFileId: 'rid-1',
        tombstonedRemoteFileIds: emptyIds,
        remoteFileIdOwners: new Map([['rid-1', record('a.md')]]),
      }),
      false,
    );
  });
});

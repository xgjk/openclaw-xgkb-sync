"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const syncDecide_1 = require("./syncDecide");
function local(path, mtime = 1000) {
    return { path, name: path.split('/').pop() ?? path, mtime, size: 1, dev: '1', ino: '1' };
}
function remote(path, remoteFileId, mtime = 1000) {
    return {
        path,
        name: path.split('/').pop() ?? path,
        mtime,
        remoteFileId,
        remoteFolderId: 'folder',
    };
}
function record(path, overrides = {}) {
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
const emptyIds = new Set();
const emptyOwners = new Map();
(0, node_test_1.describe)('decideSyncOp — 本地删除 tombstone', () => {
    (0, node_test_1.it)('本地缺 + 远端在 + 有记录 → tombstone-local（各方向）', () => {
        for (const syncDirection of ['push', 'pull', 'bidirectional']) {
            const op = (0, syncDecide_1.decideSyncOp)({
                path: 'a.md',
                local: undefined,
                remote: remote('a.md', 'rid-1'),
                record: record('a.md'),
                syncDirection,
                workspaceAnomaly: false,
                tombstonedRemoteFileIds: emptyIds,
                remoteFileIdOwners: emptyOwners,
            });
            strict_1.default.equal(op, 'tombstone-local', syncDirection);
        }
    });
    (0, node_test_1.it)('已 tombstone + 本地仍缺 → skip（绝不 download）', () => {
        for (const syncDirection of ['push', 'pull', 'bidirectional']) {
            const op = (0, syncDecide_1.decideSyncOp)({
                path: 'a.md',
                local: undefined,
                remote: remote('a.md', 'rid-1'),
                record: record('a.md', { syncStatus: 'local-deleted' }),
                syncDirection,
                workspaceAnomaly: false,
                tombstonedRemoteFileIds: new Set(['rid-1']),
                remoteFileIdOwners: emptyOwners,
            });
            strict_1.default.equal(op, 'skip', syncDirection);
        }
    });
    (0, node_test_1.it)('已 tombstone + 本地恢复：push/bidi 上传，pull 清标记', () => {
        strict_1.default.equal((0, syncDecide_1.decideSyncOp)({
            path: 'a.md',
            local: local('a.md'),
            remote: remote('a.md', 'rid-1'),
            record: record('a.md', { syncStatus: 'local-deleted' }),
            syncDirection: 'bidirectional',
            workspaceAnomaly: false,
            tombstonedRemoteFileIds: new Set(['rid-1']),
            remoteFileIdOwners: emptyOwners,
        }), 'upload-update');
        strict_1.default.equal((0, syncDecide_1.decideSyncOp)({
            path: 'a.md',
            local: local('a.md'),
            remote: remote('a.md', 'rid-1'),
            record: record('a.md', { syncStatus: 'local-deleted' }),
            syncDirection: 'pull',
            workspaceAnomaly: false,
            tombstonedRemoteFileIds: new Set(['rid-1']),
            remoteFileIdOwners: emptyOwners,
        }), 'clear-local-tombstone');
    });
    (0, node_test_1.it)('无 record 但 remoteFileId 命中 tombstone（远端 rename）→ skip', () => {
        const op = (0, syncDecide_1.decideSyncOp)({
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
        strict_1.default.equal(op, 'skip');
    });
    (0, node_test_1.it)('无 record 但 remoteFileId 归属其他路径（同轮未完成 rename）→ skip', () => {
        const op = (0, syncDecide_1.decideSyncOp)({
            path: 'b.md',
            local: undefined,
            remote: remote('b.md', 'rid-1'),
            record: undefined,
            syncDirection: 'bidirectional',
            workspaceAnomaly: false,
            tombstonedRemoteFileIds: emptyIds,
            remoteFileIdOwners: new Map([['rid-1', record('a.md')]]),
        });
        strict_1.default.equal(op, 'skip');
    });
    (0, node_test_1.it)('工作区异常偏空：双端都消失 → skip（不 tombstone）', () => {
        const op = (0, syncDecide_1.decideSyncOp)({
            path: 'a.md',
            local: undefined,
            remote: undefined,
            record: record('a.md'),
            syncDirection: 'bidirectional',
            workspaceAnomaly: true,
            tombstonedRemoteFileIds: emptyIds,
            remoteFileIdOwners: emptyOwners,
        });
        strict_1.default.equal(op, 'skip');
    });
    (0, node_test_1.it)('工作区异常偏空：本地缺+远端在 → skip（不 tombstone、不拉回）', () => {
        const op = (0, syncDecide_1.decideSyncOp)({
            path: 'a.md',
            local: undefined,
            remote: remote('a.md', 'rid-1'),
            record: record('a.md'),
            syncDirection: 'bidirectional',
            workspaceAnomaly: true,
            tombstonedRemoteFileIds: emptyIds,
            remoteFileIdOwners: emptyOwners,
        });
        strict_1.default.equal(op, 'skip');
    });
    (0, node_test_1.it)('真正的新远端文件（无归属）→ download-new', () => {
        const op = (0, syncDecide_1.decideSyncOp)({
            path: 'new.md',
            local: undefined,
            remote: remote('new.md', 'rid-new'),
            record: undefined,
            syncDirection: 'bidirectional',
            workspaceAnomaly: false,
            tombstonedRemoteFileIds: emptyIds,
            remoteFileIdOwners: emptyOwners,
        });
        strict_1.default.equal(op, 'download-new');
    });
});
(0, node_test_1.describe)('shouldBlockDownloadForRemoteIdentity', () => {
    (0, node_test_1.it)('拦截 tombstone fileId', () => {
        strict_1.default.equal((0, syncDecide_1.shouldBlockDownloadForRemoteIdentity)({
            path: 'b.md',
            remoteFileId: 'rid-1',
            tombstonedRemoteFileIds: new Set(['rid-1']),
            remoteFileIdOwners: emptyOwners,
        }), true);
    });
    (0, node_test_1.it)('拦截归属其他路径的 fileId', () => {
        strict_1.default.equal((0, syncDecide_1.shouldBlockDownloadForRemoteIdentity)({
            path: 'b.md',
            remoteFileId: 'rid-1',
            tombstonedRemoteFileIds: emptyIds,
            remoteFileIdOwners: new Map([['rid-1', record('a.md')]]),
        }), true);
    });
    (0, node_test_1.it)('同路径归属不拦截', () => {
        strict_1.default.equal((0, syncDecide_1.shouldBlockDownloadForRemoteIdentity)({
            path: 'a.md',
            remoteFileId: 'rid-1',
            tombstonedRemoteFileIds: emptyIds,
            remoteFileIdOwners: new Map([['rid-1', record('a.md')]]),
        }), false);
    });
});
//# sourceMappingURL=syncDecide.test.js.map
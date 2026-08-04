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
const assert = __importStar(require("node:assert/strict"));
const promises_1 = require("node:fs/promises");
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_test_1 = require("node:test");
const centralReporter_1 = require("./centralReporter");
const config_1 = require("./config");
const constants_1 = require("./constants");
const fileWatcher_1 = require("./fileWatcher");
const localFs_1 = require("./localFs");
const remoteFs_1 = require("./remoteFs");
const syncEngine_1 = require("./syncEngine");
const syncStateDb_1 = require("./syncStateDb");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline)
            throw new Error(`condition not met within ${timeoutMs}ms`);
        await sleep(25);
    }
}
(0, node_test_1.describe)('资源安全边界', () => {
    (0, node_test_1.it)('并发配置拒绝 0/负数并限制超大值', () => {
        assert.equal((0, config_1.boundedPositiveInteger)(0, 3, 10, 'test'), 3);
        assert.equal((0, config_1.boundedPositiveInteger)(-2, 3, 10, 'test'), 3);
        assert.equal((0, config_1.boundedPositiveInteger)(4.9, 3, 10, 'test'), 4);
        assert.equal((0, config_1.boundedPositiveInteger)(999, 3, 10, 'test'), 10);
    });
    (0, node_test_1.it)('中心停服时 execution-log 仅保留有界数量', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = ((_input, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            });
        }));
        const config = {
            serverUrl: 'http://kb.invalid/',
            syncDirection: 'push',
            autoSyncIntervalSec: 0,
            centralManagerUrl: 'http://central.invalid',
            mappings: [],
        };
        const reporter = new centralReporter_1.CentralReporter({
            getNodeIdentity: () => ({ nodeId: 'test-node', advertiseIp: '127.0.0.1' }),
            configPath: 'unused',
            projectRoot: process.cwd(),
            appVersion: '0.0.0',
            getConfig: () => config,
            getScheduler: () => undefined,
            getEventLoopLagMs: () => 0,
        });
        try {
            for (let i = 0; i < constants_1.CENTRAL_EXECUTION_LOG_MAX_PENDING + 50; i++) {
                const result = {
                    mappingId: `mapping-${i}`,
                    triggerReason: 'timer',
                    startTime: i,
                    endTime: i + 1,
                    uploaded: 0,
                    downloaded: 0,
                    deleted: 0,
                    skipped: 0,
                    failed: 0,
                };
                reporter.reportExecutionLog(result);
            }
            assert.deepEqual(reporter.getExecutionLogPressure(), {
                inFlight: constants_1.CENTRAL_EXECUTION_LOG_CONCURRENCY,
                pending: constants_1.CENTRAL_EXECUTION_LOG_MAX_PENDING,
                dropped: 48,
            });
        }
        finally {
            reporter.stop();
            globalThis.fetch = originalFetch;
            await new Promise((resolve) => setImmediate(resolve));
        }
    });
    (0, node_test_1.it)('中心立即拒绝请求时进入退避，不持续重试打满服务', async () => {
        const originalFetch = globalThis.fetch;
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls++;
            throw new Error('central unavailable');
        });
        const config = {
            serverUrl: 'http://kb.invalid/',
            syncDirection: 'push',
            autoSyncIntervalSec: 0,
            centralManagerUrl: 'http://central.invalid',
            mappings: [],
        };
        const reporter = new centralReporter_1.CentralReporter({
            getNodeIdentity: () => ({ nodeId: 'test-node', advertiseIp: '127.0.0.1' }),
            configPath: 'unused',
            projectRoot: process.cwd(),
            appVersion: '0.0.0',
            getConfig: () => config,
            getScheduler: () => undefined,
            getEventLoopLagMs: () => 0,
        });
        try {
            for (let i = 0; i < 6; i++) {
                reporter.reportExecutionLog({
                    mappingId: `mapping-${i}`,
                    triggerReason: 'timer',
                    startTime: i,
                    endTime: i + 1,
                    uploaded: 0,
                    downloaded: 0,
                    deleted: 0,
                    skipped: 0,
                    failed: 0,
                });
            }
            await waitFor(() => reporter.getExecutionLogPressure().inFlight === 0);
            assert.equal(fetchCalls, constants_1.CENTRAL_EXECUTION_LOG_CONCURRENCY);
            assert.equal(reporter.getExecutionLogPressure().pending, 4);
            await sleep(100);
            assert.equal(fetchCalls, constants_1.CENTRAL_EXECUTION_LOG_CONCURRENCY);
        }
        finally {
            reporter.stop();
            globalThis.fetch = originalFetch;
        }
    });
    (0, node_test_1.it)('restart 后旧请求的 abort 回调不污染新一代退避状态', async () => {
        const originalFetch = globalThis.fetch;
        let executionCalls = 0;
        globalThis.fetch = ((_input, init) => {
            const url = String(_input);
            if (!url.includes('/execution-log')) {
                return Promise.resolve(new Response(JSON.stringify({ resultCode: 1, data: {} }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }));
            }
            executionCalls++;
            if (executionCalls > 1) {
                return Promise.resolve(new Response(JSON.stringify({ resultCode: 1, data: {} }), { status: 200 }));
            }
            return new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    setTimeout(() => {
                        const error = new Error('old request aborted');
                        error.name = 'AbortError';
                        reject(error);
                    }, 30);
                });
            });
        });
        const config = {
            serverUrl: 'http://kb.invalid/',
            syncDirection: 'push',
            autoSyncIntervalSec: 0,
            centralManagerUrl: 'http://central.invalid',
            centralHeartbeatIntervalSec: 60,
            mappings: [],
        };
        const scheduler = {
            getGlobalSyncPressure: () => ({ running: 0, max: 0 }),
            getStatus: () => ({}),
            isSyncIdle: () => true,
        };
        const reporter = new centralReporter_1.CentralReporter({
            getNodeIdentity: () => ({ nodeId: 'test-node', advertiseIp: '127.0.0.1' }),
            configPath: 'unused',
            projectRoot: process.cwd(),
            appVersion: '0.0.0',
            getConfig: () => config,
            getScheduler: () => scheduler,
            getEventLoopLagMs: () => 0,
        });
        const result = (mappingId) => ({
            mappingId,
            triggerReason: 'timer',
            startTime: 1,
            endTime: 2,
            uploaded: 0,
            downloaded: 0,
            deleted: 0,
            skipped: 0,
            failed: 0,
        });
        try {
            reporter.reportExecutionLog(result('old'));
            reporter.restart();
            reporter.reportExecutionLog(result('new-1'));
            await waitFor(() => executionCalls === 2);
            await sleep(70);
            reporter.reportExecutionLog(result('new-2'));
            await waitFor(() => executionCalls === 3, 500);
        }
        finally {
            reporter.stop();
            globalThis.fetch = originalFetch;
        }
    });
});
(0, node_test_1.describe)('共享文件监听语义', () => {
    const tempDirs = [];
    (0, node_test_1.afterEach)(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => (0, promises_1.rm)(dir, { recursive: true, force: true })));
    });
    (0, node_test_1.it)('父子 mapping 分别执行 scope、pause、ignore 和 stop', async () => {
        const root = await (0, promises_1.mkdtemp)(path.join(os.tmpdir(), 'openclaw-watch-'));
        tempDirs.push(root);
        const nested = path.join(root, 'nested');
        await (0, promises_1.mkdir)(nested, { recursive: true });
        const backend = new fileWatcher_1.SharedFileWatcherBackend(false);
        let parentBatches = 0;
        let childBatches = 0;
        const parent = new fileWatcher_1.FileWatcher({
            mappingId: 'parent',
            localRoot: root,
            scope: {
                filePatterns: ['**/*.md'],
                excludePatterns: ['**/excluded/**'],
                syncDotFiles: false,
            },
            debounceMs: 50,
            usePolling: false,
            onBatchReady: () => parentBatches++,
        }, backend);
        const child = new fileWatcher_1.FileWatcher({
            mappingId: 'child',
            localRoot: nested,
            scope: {
                filePatterns: ['**/*.json'],
                excludePatterns: [],
                syncDotFiles: false,
            },
            debounceMs: 50,
            usePolling: false,
            onBatchReady: () => childBatches++,
        }, backend);
        parent.start();
        child.start();
        backend.start();
        try {
            await backend.waitUntilReady();
            await (0, promises_1.writeFile)(path.join(nested, 'parent.md'), 'md');
            await waitFor(() => parentBatches === 1);
            await sleep(450);
            assert.equal(childBatches, 0);
            await (0, promises_1.writeFile)(path.join(nested, 'child.json'), '{}');
            await waitFor(() => childBatches === 1);
            await sleep(450);
            assert.equal(parentBatches, 1);
            await (0, promises_1.mkdir)(path.join(root, 'excluded'), { recursive: true });
            await sleep(450);
            assert.equal(parentBatches, 1, 'excluded directory event must not trigger parent mapping');
            parent.pause();
            await (0, promises_1.writeFile)(path.join(root, 'paused.md'), 'paused');
            await sleep(700);
            assert.equal(parentBatches, 1);
            parent.resumeAfterSync(['echo.md']);
            await (0, promises_1.writeFile)(path.join(root, 'echo.md'), 'echo');
            await sleep(700);
            assert.equal(parentBatches, 1);
            await (0, promises_1.writeFile)(path.join(root, 'live.md'), 'live');
            await waitFor(() => parentBatches === 2);
            await child.stop();
            await (0, promises_1.writeFile)(path.join(nested, 'after-stop.json'), '{}');
            await sleep(700);
            assert.equal(childBatches, 1);
            assert.equal(backend.isActive(), true);
        }
        finally {
            await parent.stop();
            await child.stop();
            await backend.stop();
        }
    });
});
(0, node_test_1.describe)('本地快照单次遍历', () => {
    const tempDirs = [];
    (0, node_test_1.afterEach)(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => (0, promises_1.rm)(dir, { recursive: true, force: true })));
    });
    (0, node_test_1.it)('同时返回文件和目录并应用同步范围', async () => {
        const root = await (0, promises_1.mkdtemp)(path.join(os.tmpdir(), 'openclaw-snapshot-'));
        tempDirs.push(root);
        await (0, promises_1.mkdir)(path.join(root, 'notes'), { recursive: true });
        await (0, promises_1.mkdir)(path.join(root, 'skip'), { recursive: true });
        await (0, promises_1.mkdir)(path.join(root, '.hidden'), { recursive: true });
        await (0, promises_1.writeFile)(path.join(root, 'root.md'), 'root');
        await (0, promises_1.writeFile)(path.join(root, 'notes', 'a.md'), 'a');
        await (0, promises_1.writeFile)(path.join(root, 'notes', 'ignored.txt'), 'ignored');
        await (0, promises_1.writeFile)(path.join(root, 'skip', 'b.md'), 'skip');
        await (0, promises_1.writeFile)(path.join(root, '.hidden', 'c.md'), 'hidden');
        const localFs = new localFs_1.LocalFsAdapter(root, {
            filePatterns: ['**/*.md'],
            excludePatterns: ['**/skip/**'],
            syncDotFiles: false,
        });
        const snapshot = await localFs.listSnapshot();
        assert.deepEqual(snapshot.files.map((f) => f.path).sort(), ['notes/a.md', 'root.md']);
        assert.deepEqual(snapshot.directories.map((d) => d.path).sort(), ['notes']);
    });
    (0, node_test_1.it)('Buffer 读写保持原始字节，不经过 UTF-8 往返转换', async () => {
        const root = await (0, promises_1.mkdtemp)(path.join(os.tmpdir(), 'openclaw-buffer-'));
        tempDirs.push(root);
        const localFs = new localFs_1.LocalFsAdapter(root, {
            filePatterns: ['**/*'],
            excludePatterns: [],
            syncDotFiles: false,
        });
        const bytes = Buffer.from([0xff, 0x00, 0x61, 0xc3, 0x28]);
        await localFs.writeFileBuffer('binary.dat', bytes);
        assert.deepEqual(await localFs.readFileBuffer('binary.dat'), bytes);
        assert.deepEqual(await (0, promises_1.readFile)(path.join(root, 'binary.dat')), bytes);
    });
});
(0, node_test_1.describe)('远端正文内存边界', () => {
    (0, node_test_1.it)('流式读取超过单文件上限时中止，未超过时保持原始字节', async () => {
        const originalFetch = globalThis.fetch;
        const bytes = Uint8Array.from([0xff, 0x00, 0x61, 0xc3, 0x28]);
        const fakeApi = {
            getDownloadInfo: async () => ({
                ok: true,
                value: { fileId: 'file-1', downloadUrl: 'http://download.invalid/file-1' },
            }),
            getFullFileContent: async () => ({ ok: false, error: 'not expected' }),
        };
        globalThis.fetch = (async () => new Response(bytes));
        try {
            const limited = new remoteFs_1.RemoteFsAdapter(fakeApi, { maxFileSizeBytes: 4 });
            const limitedResult = await limited.readFileBuffer('file-1');
            assert.equal(limitedResult.ok, false);
            const allowed = new remoteFs_1.RemoteFsAdapter(fakeApi, { maxFileSizeBytes: 10 });
            const allowedResult = await allowed.readFileBuffer('file-1');
            assert.equal(allowedResult.ok, true);
            if (allowedResult.ok)
                assert.deepEqual(allowedResult.value, Buffer.from(bytes));
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
(0, node_test_1.describe)('核心同步编排', () => {
    const tempDirs = [];
    (0, node_test_1.afterEach)(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => (0, promises_1.rm)(dir, { recursive: true, force: true })));
    });
    (0, node_test_1.it)('push 将原始文件字节上传并写入 remoteFileId 状态', async () => {
        const root = await (0, promises_1.mkdtemp)(path.join(os.tmpdir(), 'openclaw-push-'));
        tempDirs.push(root);
        const bytes = Buffer.from([0xff, 0x00, 0x61, 0xc3, 0x28]);
        await (0, promises_1.writeFile)(path.join(root, 'doc.md'), bytes);
        const db = new syncStateDb_1.SyncStateDb(path.join(root, 'state.db'));
        let uploaded;
        const remote = {
            getRootFileId: () => 'root',
            listFiles: async () => ({ ok: true, value: [] }),
            createFile: async (_relativePath, content) => {
                uploaded = Buffer.from(content);
                return {
                    ok: true,
                    value: { remoteFileId: 'remote-1', remoteFolderId: 'root' },
                };
            },
        };
        const local = new localFs_1.LocalFsAdapter(root, {
            filePatterns: ['**/*.md'],
            excludePatterns: ['state.db*'],
            syncDotFiles: false,
        });
        const engine = new syncEngine_1.SyncEngine(local, remote, db, {
            mappingId: 'push-test',
            enabled: true,
            localRoot: root,
            syncDirection: 'push',
            filePatterns: ['**/*.md'],
            excludePatterns: ['state.db*'],
        }, { maxFileSizeBytes: 1024 });
        try {
            const stats = await engine.runSync();
            assert.equal(stats.uploaded, 1);
            assert.equal(stats.failed, 0);
            assert.deepEqual(uploaded, bytes);
            assert.equal(db.getFileState('push-test', 'doc.md')?.remoteFileId, 'remote-1');
        }
        finally {
            db.close();
        }
    });
    (0, node_test_1.it)('pull 将远端原始字节落盘并写入同步状态', async () => {
        const root = await (0, promises_1.mkdtemp)(path.join(os.tmpdir(), 'openclaw-pull-'));
        tempDirs.push(root);
        const bytes = Buffer.from([0xff, 0x00, 0x61, 0xc3, 0x28]);
        const db = new syncStateDb_1.SyncStateDb(path.join(root, 'state.db'));
        const remote = {
            getRootFileId: () => 'root',
            listFiles: async () => ({
                ok: true,
                value: [
                    {
                        path: 'doc.md',
                        name: 'doc.md',
                        mtime: 123,
                        size: bytes.length,
                        remoteFileId: 'remote-2',
                        remoteFolderId: 'root',
                    },
                ],
            }),
            readFileBuffer: async () => ({ ok: true, value: Buffer.from(bytes) }),
        };
        const local = new localFs_1.LocalFsAdapter(root, {
            filePatterns: ['**/*.md'],
            excludePatterns: ['state.db*'],
            syncDotFiles: false,
        });
        const engine = new syncEngine_1.SyncEngine(local, remote, db, {
            mappingId: 'pull-test',
            enabled: true,
            localRoot: root,
            syncDirection: 'pull',
            filePatterns: ['**/*.md'],
            excludePatterns: ['state.db*'],
        }, { maxFileSizeBytes: 1024 });
        try {
            const stats = await engine.runSync();
            assert.equal(stats.downloaded, 1);
            assert.equal(stats.failed, 0);
            assert.deepEqual(await (0, promises_1.readFile)(path.join(root, 'doc.md')), bytes);
            assert.equal(db.getFileState('pull-test', 'doc.md')?.remoteFileId, 'remote-2');
        }
        finally {
            db.close();
        }
    });
});
//# sourceMappingURL=resourceSafety.test.js.map
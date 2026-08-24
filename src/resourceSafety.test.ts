import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { Database } from 'node-sqlite3-wasm';
import { CentralReporter } from './centralReporter';
import { boundedPositiveInteger, parseSyncConfig } from './config';
import {
  CENTRAL_EXECUTION_LOG_CONCURRENCY,
  CENTRAL_EXECUTION_LOG_MAX_PENDING,
  MAX_PENDING_WATCH_PATHS,
} from './constants';
import { pruneOldLogSegments } from './consoleTee';
import { compactWatchRoots, FileWatcher, SharedFileWatcherBackend } from './fileWatcher';
import type { KbApiClient } from './kbApi';
import { LocalFsAdapter } from './localFs';
import { RemoteFsAdapter } from './remoteFs';
import { SyncScheduler } from './scheduler';
import { SyncEngine } from './syncEngine';
import { SyncStateDb } from './syncStateDb';
import {
  classifyPermanentSyncFailure,
  permanentCircuitDelayMs,
} from './syncErrorPolicy';
import type { MappingSyncRunResult, SyncConfig } from './types';
import { evaluateMassSyncProtection, MassSyncProtectionError } from './syncSafety';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await sleep(25);
  }
}

describe('资源安全边界', () => {
  it('并发配置拒绝 0/负数并限制超大值', () => {
    assert.equal(boundedPositiveInteger(0, 3, 10, 'test'), 3);
    assert.equal(boundedPositiveInteger(-2, 3, 10, 'test'), 3);
    assert.equal(boundedPositiveInteger(4.9, 3, 10, 'test'), 4);
    assert.equal(boundedPositiveInteger(999, 3, 10, 'test'), 10);
  });

  it('单轮上传/下载超过阈值时生成 mapping 级保护原因和有限样本', () => {
    const uploads = Array.from({ length: 1_501 }, (_, i) => ({
      path: `vendor/repo-${i}.md`,
      op: 'upload-new' as const,
    }));
    const trip = evaluateMassSyncProtection({
      enabled: true,
      uploadPlans: uploads,
      downloadPlans: [],
      maxUploads: 1_000,
      maxDownloads: 1_000,
      localFileCount: 1_600,
      remoteFileCount: 100,
      knownFileCount: 100,
    });

    assert.ok(trip);
    assert.equal(trip.uploadCount, 1_501);
    assert.equal(trip.samplePaths.length, 20);
    assert.match(trip.reason, /mapping 将被自动禁用/);
    assert.equal(
      evaluateMassSyncProtection({
        enabled: false,
        uploadPlans: uploads,
        downloadPlans: [],
        maxUploads: 1_000,
        maxDownloads: 1_000,
        localFileCount: 1_600,
        remoteFileCount: 100,
        knownFileCount: 100,
      }),
      null,
    );
  });

  it('批量保护配置支持全局默认和 mapping 覆盖', () => {
    const config = parseSyncConfig({
      serverUrl: 'http://kb.invalid/',
      syncDirection: 'bidirectional',
      autoSyncIntervalSec: 180,
      massSyncProtectionEnabled: true,
      maxUploadFilesPerSync: 2_000,
      maxDownloadFilesPerSync: 3_000,
      mappings: [
        {
          mappingId: 'mapping-1',
          localRoot: process.cwd(),
          massSyncProtectionEnabled: false,
          maxUploadFilesPerSync: 5_000,
        },
      ],
    });
    assert.equal(config.maxUploadFilesPerSync, 2_000);
    assert.equal(config.maxDownloadFilesPerSync, 3_000);
    assert.equal(config.mappings[0].massSyncProtectionEnabled, false);
    assert.equal(config.mappings[0].maxUploadFilesPerSync, 5_000);
  });

  it('刷新远端目录映射时保留已有 inode，避免全量扫描破坏 rename 检测', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-folder-inode-'));
    const db = new SyncStateDb(path.join(root, 'state.db'));
    try {
      db.upsertFolderState({
        mappingId: 'mapping-1',
        localPath: 'docs',
        remoteFolderId: 'old-folder',
        localDev: '10',
        localIno: '20',
      });
      db.upsertFolderState({
        mappingId: 'mapping-1',
        localPath: 'docs',
        remoteFolderId: 'new-folder',
      });
      assert.deepEqual(db.getFolderState('mapping-1', 'docs'), {
        mappingId: 'mapping-1',
        localPath: 'docs',
        remoteFolderId: 'new-folder',
        localDev: '10',
        localIno: '20',
      });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('热重载停止超时会恢复旧 scheduler，而不是永久停摆', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-reload-rollback-'));
    const scheduler = new SyncScheduler(
      {
        serverUrl: 'http://kb.invalid/',
        syncDirection: 'push',
        autoSyncIntervalSec: 0,
        stateDbPath: path.join(root, 'state.db'),
        startupJitterMaxSec: 0,
        mappings: [],
      },
      { stopDrainTimeoutMs: 10 },
    );
    scheduler.start();
    (scheduler as unknown as { activeSyncCount: number }).activeSyncCount = 1;
    try {
      assert.equal(await scheduler.stop({ resumeOnTimeout: true }), false);
      assert.deepEqual(scheduler.getLifecycleStatus(), { running: true, dbClosed: false });
    } finally {
      (scheduler as unknown as { activeSyncCount: number }).activeSyncCount = 0;
      await scheduler.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('瞬时新增上万文件不会触发逐目录远端解析候选', () => {
    const engine = Object.create(SyncEngine.prototype) as SyncEngine;
    const localFiles = Array.from({ length: 10_000 }, (_, i) => ({
      path: `vendor/repo-${i}/README.md`,
      name: 'README.md',
      mtime: 1,
      size: 1,
      dev: '1',
      ino: String(i + 1),
    }));
    const targets = (
      engine as unknown as {
        collectMovedTargetDirPaths: (
          files: typeof localFiles,
          dirs: [],
          records: [],
          folderRecords: [],
        ) => string[];
      }
    ).collectMovedTargetDirPaths(localFiles, [], [], []);
    assert.deepEqual(targets, []);
  });

  it('日志总量清理只删除同前缀旧分段并保留当前文件', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-log-prune-'));
    const old0 = path.join(root, 'openclaw-sync-2026-01-01.log');
    const old1 = path.join(root, 'openclaw-sync-2026-01-01.1.log');
    const current = path.join(root, 'openclaw-sync-2026-01-02.log');
    await writeFile(old0, 'a'.repeat(40));
    await writeFile(old1, 'b'.repeat(40));
    await writeFile(current, 'c'.repeat(40));
    await writeFile(path.join(root, 'unrelated-2026-01-01.log'), 'keep');
    try {
      const result = pruneOldLogSegments(root, 'openclaw-sync', 50, current);
      assert.equal(result.deletedFiles, 2);
      assert.deepEqual((await readdir(root)).sort(), [
        'openclaw-sync-2026-01-02.log',
        'unrelated-2026-01-01.log',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('中心停服时 execution-log 仅保留有界数量', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as typeof fetch;

    const config: SyncConfig = {
      serverUrl: 'http://kb.invalid/',
      syncDirection: 'push',
      autoSyncIntervalSec: 0,
      centralManagerUrl: 'http://central.invalid',
      mappings: [],
    };
    const reporter = new CentralReporter({
      getNodeIdentity: () => ({ nodeId: 'test-node', advertiseIp: '127.0.0.1' }),
      configPath: 'unused',
      projectRoot: process.cwd(),
      appVersion: '0.0.0',
      getConfig: () => config,
      getScheduler: () => undefined as unknown as SyncScheduler,
      getEventLoopLagMs: () => 0,
    });

    try {
      for (let i = 0; i < CENTRAL_EXECUTION_LOG_MAX_PENDING + 50; i++) {
        const result: MappingSyncRunResult = {
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
        inFlight: CENTRAL_EXECUTION_LOG_CONCURRENCY,
        pending: CENTRAL_EXECUTION_LOG_MAX_PENDING,
        dropped: 48,
      });
    } finally {
      reporter.stop();
      globalThis.fetch = originalFetch;
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it('中心立即拒绝请求时进入退避，不持续重试打满服务', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('central unavailable');
    }) as typeof fetch;

    const config: SyncConfig = {
      serverUrl: 'http://kb.invalid/',
      syncDirection: 'push',
      autoSyncIntervalSec: 0,
      centralManagerUrl: 'http://central.invalid',
      mappings: [],
    };
    const reporter = new CentralReporter({
      getNodeIdentity: () => ({ nodeId: 'test-node', advertiseIp: '127.0.0.1' }),
      configPath: 'unused',
      projectRoot: process.cwd(),
      appVersion: '0.0.0',
      getConfig: () => config,
      getScheduler: () => undefined as unknown as SyncScheduler,
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
      assert.equal(fetchCalls, CENTRAL_EXECUTION_LOG_CONCURRENCY);
      assert.equal(reporter.getExecutionLogPressure().pending, 4);
      await sleep(100);
      assert.equal(fetchCalls, CENTRAL_EXECUTION_LOG_CONCURRENCY);
    } finally {
      reporter.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('restart 后旧请求的 abort 回调不污染新一代退避状态', async () => {
    const originalFetch = globalThis.fetch;
    let executionCalls = 0;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      const url = String(_input);
      if (!url.includes('/execution-log')) {
        return Promise.resolve(
          new Response(JSON.stringify({ resultCode: 1, data: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      executionCalls++;
      if (executionCalls > 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ resultCode: 1, data: {} }), { status: 200 }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          setTimeout(() => {
            const error = new Error('old request aborted');
            error.name = 'AbortError';
            reject(error);
          }, 30);
        });
      });
    }) as typeof fetch;

    const config: SyncConfig = {
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
    } as unknown as SyncScheduler;
    const reporter = new CentralReporter({
      getNodeIdentity: () => ({ nodeId: 'test-node', advertiseIp: '127.0.0.1' }),
      configPath: 'unused',
      projectRoot: process.cwd(),
      appVersion: '0.0.0',
      getConfig: () => config,
      getScheduler: () => scheduler,
      getEventLoopLagMs: () => 0,
    });
    const result = (mappingId: string): MappingSyncRunResult => ({
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
    } finally {
      reporter.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('中心每次心跳都返回 config 时只记录一次忽略提示', async () => {
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ resultCode: 1, data: { config: { mappings: [] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const config: SyncConfig = {
      serverUrl: 'http://kb.invalid/',
      syncDirection: 'push',
      autoSyncIntervalSec: 0,
      centralManagerUrl: 'http://central.invalid',
      autoUpgradeEnabled: false,
      mappings: [],
    };
    const scheduler = {
      getGlobalSyncPressure: () => ({ running: 0, max: 1 }),
      getStatus: () => ({}),
      isSyncIdle: () => true,
    } as unknown as SyncScheduler;
    const reporter = new CentralReporter({
      getNodeIdentity: () => ({ nodeId: 'test-node', advertiseIp: '127.0.0.1' }),
      configPath: 'unused',
      projectRoot: process.cwd(),
      appVersion: '1.0.0',
      getConfig: () => config,
      getScheduler: () => scheduler,
      getEventLoopLagMs: () => 0,
    });

    try {
      const invoke = reporter as unknown as { sendHeartbeat(): Promise<void> };
      await invoke.sendHeartbeat();
      await invoke.sendHeartbeat();
      assert.equal(logs.filter((line) => line.includes('心跳响应含 config 字段')).length, 1);
    } finally {
      reporter.stop();
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }
  });
});

describe('共享文件监听语义', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('debounce 路径集合达到上限后只计数，不继续持有字符串', async () => {
    const watcher = new FileWatcher({
      mappingId: 'bounded-paths',
      localRoot: process.cwd(),
      scope: { filePatterns: ['**/*'], excludePatterns: [], syncDotFiles: true },
      debounceMs: 60_000,
      usePolling: false,
      onBatchReady: () => undefined,
    });
    const internals = watcher as unknown as {
      recordPendingPath: (relativePath: string) => void;
      pendingPaths: Set<string>;
      pendingPathOverflowCount: number;
    };
    for (let i = 0; i < MAX_PENDING_WATCH_PATHS + 5_000; i++) {
      internals.recordPendingPath(`bulk/path-${i}.md`);
    }
    assert.equal(internals.pendingPaths.size, MAX_PENDING_WATCH_PATHS);
    assert.equal(internals.pendingPathOverflowCount, 5_000);
    await watcher.stop();
  });

  it('递归 watcher root 会合并重复和父子重叠目录', () => {
    const root = path.resolve('watch-root');
    const nested = path.join(root, 'nested');
    const sibling = path.resolve('watch-sibling');
    assert.deepEqual(compactWatchRoots([nested, root, root, sibling]), [root, sibling].sort(
      (a, b) => a.length - b.length || a.localeCompare(b),
    ));
  });

  it('父子 mapping 分别执行 scope、pause、ignore 和 stop', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-watch-'));
    tempDirs.push(root);
    const nested = path.join(root, 'nested');
    await mkdir(nested, { recursive: true });

    const backend = new SharedFileWatcherBackend(false);
    let parentBatches = 0;
    let childBatches = 0;
    const parent = new FileWatcher(
      {
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
      },
      backend,
    );
    const child = new FileWatcher(
      {
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
      },
      backend,
    );

    parent.start();
    child.start();
    backend.start();
    try {
      await backend.waitUntilReady();

      await writeFile(path.join(nested, 'parent.md'), 'md');
      await waitFor(() => parentBatches === 1);
      await sleep(450);
      assert.equal(childBatches, 0);

      await writeFile(path.join(nested, 'child.json'), '{}');
      await waitFor(() => childBatches === 1);
      await sleep(450);
      assert.equal(parentBatches, 1);

      await mkdir(path.join(root, 'excluded'), { recursive: true });
      await sleep(450);
      assert.equal(parentBatches, 1, 'excluded directory event must not trigger parent mapping');

      parent.pause();
      await writeFile(path.join(root, 'paused.md'), 'paused');
      await sleep(700);
      assert.equal(parentBatches, 1);

      parent.resumeAfterSync(['echo.md']);
      await writeFile(path.join(root, 'echo.md'), 'echo');
      await sleep(700);
      assert.equal(parentBatches, 1);

      await writeFile(path.join(root, 'live.md'), 'live');
      await waitFor(() => parentBatches === 2);

      await child.stop();
      await writeFile(path.join(nested, 'after-stop.json'), '{}');
      await sleep(700);
      assert.equal(childBatches, 1);
      assert.equal(backend.isActive(), true);
    } finally {
      await parent.stop();
      await child.stop();
      await backend.stop();
    }
  });

  it(
    'macOS 原生递归 backend 用一个父 root 覆盖嵌套目录并触发批次',
    { skip: process.platform !== 'darwin' && process.platform !== 'win32' },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-native-watch-'));
      tempDirs.push(root);
      const nested = path.join(root, 'nested');
      await mkdir(nested, { recursive: true });
      const backend = new SharedFileWatcherBackend(false, 'darwin');
      let batches = 0;
      const watcher = new FileWatcher(
        {
          mappingId: 'native-parent',
          localRoot: root,
          scope: {
            filePatterns: ['**/*.md'],
            excludePatterns: [],
            syncDotFiles: false,
          },
          debounceMs: 50,
          usePolling: false,
          onBatchReady: () => batches++,
        },
        backend,
      );
      watcher.start();
      backend.start();
      try {
        await backend.waitUntilReady();
        assert.equal(backend.getMode(), 'darwin-native-recursive');
        assert.equal(backend.getWatchedRootCount(), 1);
        assert.equal(backend.getWatchedDirectoryCount(), 0);
        await writeFile(path.join(root, '.openclaw-sync-map.json'), '{}');
        await sleep(250);
        assert.equal(batches, 0, 'mapping index must never trigger native watcher sync');
        await writeFile(path.join(nested, 'native.md'), 'native');
        await waitFor(() => batches === 1);
      } finally {
        await watcher.stop();
        await backend.stop();
      }
    },
  );
});

describe('本地快照单次遍历', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('同时返回文件和目录并应用同步范围', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-snapshot-'));
    tempDirs.push(root);
    await mkdir(path.join(root, 'notes'), { recursive: true });
    await mkdir(path.join(root, 'skip'), { recursive: true });
    await mkdir(path.join(root, '.hidden'), { recursive: true });
    await writeFile(path.join(root, 'root.md'), 'root');
    await writeFile(path.join(root, 'notes', 'a.md'), 'a');
    await writeFile(path.join(root, 'notes', 'ignored.txt'), 'ignored');
    await writeFile(path.join(root, 'skip', 'b.md'), 'skip');
    await writeFile(path.join(root, '.hidden', 'c.md'), 'hidden');

    const localFs = new LocalFsAdapter(root, {
      filePatterns: ['**/*.md'],
      excludePatterns: ['**/skip/**'],
      syncDotFiles: false,
    });
    const snapshot = await localFs.listSnapshot();

    assert.deepEqual(snapshot.files.map((f) => f.path).sort(), ['notes/a.md', 'root.md']);
    assert.deepEqual(snapshot.directories.map((d) => d.path).sort(), ['notes']);
  });

  it('Buffer 读写保持原始字节，不经过 UTF-8 往返转换', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-buffer-'));
    tempDirs.push(root);
    const localFs = new LocalFsAdapter(root, {
      filePatterns: ['**/*'],
      excludePatterns: [],
      syncDotFiles: false,
    });
    const bytes = Buffer.from([0xff, 0x00, 0x61, 0xc3, 0x28]);

    await localFs.writeFileBuffer('binary.dat', bytes);

    assert.deepEqual(await localFs.readFileBuffer('binary.dat'), bytes);
    assert.deepEqual(await readFile(path.join(root, 'binary.dat')), bytes);
  });
});

describe('远端正文内存边界', () => {
  it('流式读取超过单文件上限时中止，未超过时保持原始字节', async () => {
    const originalFetch = globalThis.fetch;
    const bytes = Uint8Array.from([0xff, 0x00, 0x61, 0xc3, 0x28]);
    const fakeApi = {
      getDownloadInfo: async () => ({
        ok: true as const,
        value: { fileId: 'file-1', downloadUrl: 'http://download.invalid/file-1' },
      }),
      getFullFileContent: async () => ({ ok: false as const, error: 'not expected' }),
    } as unknown as KbApiClient;
    globalThis.fetch = (async () => new Response(bytes)) as typeof fetch;

    try {
      const limited = new RemoteFsAdapter(fakeApi, { maxFileSizeBytes: 4 });
      const limitedResult = await limited.readFileBuffer('file-1');
      assert.equal(limitedResult.ok, false);

      const allowed = new RemoteFsAdapter(fakeApi, { maxFileSizeBytes: 10 });
      const allowedResult = await allowed.readFileBuffer('file-1');
      assert.equal(allowedResult.ok, true);
      if (allowedResult.ok) assert.deepEqual(allowedResult.value, Buffer.from(bytes));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('批量下载失败日志带 mappingId 且只输出有界样本', async () => {
    const adapter = new RemoteFsAdapter({} as KbApiClient, { mappingId: 'log-test' });
    const fake = adapter as unknown as {
      readFile(fileId: string): Promise<{ ok: false; error: string }>;
    };
    fake.readFile = async (fileId: string) => ({ ok: false, error: `failed-${fileId}` });

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    try {
      await adapter.readFilesBatch(Array.from({ length: 20 }, (_, i) => `file-${i}`));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /\[RemoteFs\]\[log-test\]/);
      assert.match(warnings[0], /failed=20\/20/);
      assert.match(warnings[0], /file-4/);
      assert.doesNotMatch(warnings[0], /file-5/);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('核心同步编排', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('push 将原始文件字节上传并写入 remoteFileId 状态', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-push-'));
    tempDirs.push(root);
    const bytes = Buffer.from([0xff, 0x00, 0x61, 0xc3, 0x28]);
    await writeFile(path.join(root, 'doc.md'), bytes);
    const db = new SyncStateDb(path.join(root, 'state.db'));
    let uploaded: Buffer | undefined;
    const remote = {
      getRootFileId: () => 'root',
      listFiles: async () => ({ ok: true as const, value: [] }),
      createFile: async (_relativePath: string, content: Buffer) => {
        uploaded = Buffer.from(content);
        return {
          ok: true as const,
          value: { remoteFileId: 'remote-1', remoteFolderId: 'root' },
        };
      },
    } as unknown as RemoteFsAdapter;
    const local = new LocalFsAdapter(root, {
      filePatterns: ['**/*.md'],
      excludePatterns: ['state.db*'],
      syncDotFiles: false,
    });
    const engine = new SyncEngine(
      local,
      remote,
      db,
      {
        mappingId: 'push-test',
        enabled: true,
        localRoot: root,
        syncDirection: 'push',
        filePatterns: ['**/*.md'],
        excludePatterns: ['state.db*'],
      },
      { maxFileSizeBytes: 1024 },
    );

    try {
      const stats = await engine.runSync();
      assert.equal(stats.uploaded, 1);
      assert.equal(stats.failed, 0);
      assert.deepEqual(uploaded, bytes);
      assert.equal(db.getFileState('push-test', 'doc.md')?.remoteFileId, 'remote-1');
    } finally {
      db.close();
    }
  });

  it('异常批量上传在首个远端写操作前中止', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-mass-upload-stop-'));
    tempDirs.push(root);
    for (let i = 0; i < 4; i++) {
      await writeFile(path.join(root, `bulk-${i}.md`), `file-${i}`);
    }
    const db = new SyncStateDb(path.join(root, 'state.db'));
    let createCalls = 0;
    const remote = {
      getRootFileId: () => 'root',
      listFiles: async () => ({ ok: true as const, value: [] }),
      createFile: async () => {
        createCalls++;
        return {
          ok: true as const,
          value: { remoteFileId: 'unexpected', remoteFolderId: 'root' },
        };
      },
    } as unknown as RemoteFsAdapter;
    const local = new LocalFsAdapter(root, {
      filePatterns: ['**/*.md'],
      excludePatterns: ['state.db*'],
      syncDotFiles: false,
    });
    const engine = new SyncEngine(
      local,
      remote,
      db,
      {
        mappingId: 'mass-upload-stop-test',
        enabled: true,
        localRoot: root,
        syncDirection: 'push',
        filePatterns: ['**/*.md'],
        excludePatterns: ['state.db*'],
      },
      { maxUploadFilesPerSync: 3 },
    );

    try {
      await assert.rejects(() => engine.runSync(), MassSyncProtectionError);
      assert.equal(createCalls, 0);
      assert.equal(db.countFileStates('mass-upload-stop-test'), 0);
    } finally {
      db.close();
    }
  });

  it('明确权限错误只执行单文件探测，剩余上传计划快速停止', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-permission-stop-'));
    tempDirs.push(root);
    for (let i = 0; i < 10; i++) {
      await writeFile(path.join(root, `doc-${i}.md`), `file-${i}`);
    }
    const db = new SyncStateDb(path.join(root, 'state.db'));
    let createCalls = 0;
    const remote = {
      getRootFileId: () => 'root',
      listFiles: async () => ({ ok: true as const, value: [] }),
      createFile: async () => {
        createCalls++;
        return { ok: false as const, error: 'API error 0: 权限不足' };
      },
    } as unknown as RemoteFsAdapter;
    const local = new LocalFsAdapter(root, {
      filePatterns: ['**/*.md'],
      excludePatterns: ['state.db*'],
      syncDotFiles: false,
    });
    const engine = new SyncEngine(
      local,
      remote,
      db,
      {
        mappingId: 'permission-stop-test',
        enabled: true,
        localRoot: root,
        syncDirection: 'push',
        filePatterns: ['**/*.md'],
        excludePatterns: ['state.db*'],
      },
      { uploadConcurrency: 3, maxFileSizeBytes: 1024 },
    );

    try {
      const stats = await engine.runSync();
      assert.equal(createCalls, 1);
      assert.equal(stats.failed, 1);
      assert.equal(stats.skipped, 9);
      assert.equal(engine.getPermanentFailure()?.category, 'permission');
    } finally {
      db.close();
    }
  });

  it('单文件参数错误不熔断 mapping，其他文件仍可继续上传', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-validation-isolation-'));
    tempDirs.push(root);
    for (let i = 0; i < 3; i++) {
      await writeFile(path.join(root, `doc-${i}.md`), `file-${i}`);
    }
    const db = new SyncStateDb(path.join(root, 'state.db'));
    const created: string[] = [];
    const remote = {
      getRootFileId: () => 'root',
      listFiles: async () => ({ ok: true as const, value: [] }),
      createFile: async (relativePath: string) => {
        if (relativePath === 'doc-0.md') {
          return { ok: false as const, error: 'API error 400001: 参数错误' };
        }
        created.push(relativePath);
        return {
          ok: true as const,
          value: { remoteFileId: `remote-${relativePath}`, remoteFolderId: 'root' },
        };
      },
    } as unknown as RemoteFsAdapter;
    const local = new LocalFsAdapter(root, {
      filePatterns: ['**/*.md'],
      excludePatterns: ['state.db*'],
      syncDotFiles: false,
    });
    const engine = new SyncEngine(
      local,
      remote,
      db,
      {
        mappingId: 'validation-isolation-test',
        enabled: true,
        localRoot: root,
        syncDirection: 'push',
        filePatterns: ['**/*.md'],
        excludePatterns: ['state.db*'],
      },
      { uploadConcurrency: 2, maxFileSizeBytes: 1024 },
    );

    try {
      const stats = await engine.runSync();
      assert.equal(stats.failed, 1);
      assert.equal(stats.uploaded, 2);
      assert.deepEqual(created.sort(), ['doc-1.md', 'doc-2.md']);
      assert.equal(engine.getPermanentFailure(), null);
    } finally {
      db.close();
    }
  });

  it('远端目录检查失败时不得继续删除目录，并保留状态供下轮重试', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-prune-guard-'));
    tempDirs.push(root);
    const db = new SyncStateDb(path.join(root, 'state.db'));
    db.upsertFolderState({
      mappingId: 'prune-guard-test',
      localPath: 'removed-dir',
      remoteFolderId: 'remote-folder',
    });
    let deleteCalls = 0;
    const remote = {
      getRootFileId: () => 'root',
      listFiles: async () => ({ ok: true as const, value: [] }),
      getChildFiles: async () => ({ ok: false as const, error: 'HTTP 500: unavailable' }),
      deleteFile: async () => {
        deleteCalls++;
        return { ok: true as const, value: undefined };
      },
    } as unknown as RemoteFsAdapter;
    const local = new LocalFsAdapter(root, {
      filePatterns: ['**/*.md'],
      excludePatterns: ['state.db*'],
      syncDotFiles: false,
    });
    const engine = new SyncEngine(
      local,
      remote,
      db,
      {
        mappingId: 'prune-guard-test',
        enabled: true,
        localRoot: root,
        syncDirection: 'push',
        filePatterns: ['**/*.md'],
        excludePatterns: ['state.db*'],
      },
    );

    try {
      const stats = await engine.runSync();
      assert.equal(deleteCalls, 0);
      assert.equal(stats.failed, 1);
      assert.equal(db.getFolderState('prune-guard-test', 'removed-dir')?.remoteFolderId, 'remote-folder');
    } finally {
      db.close();
    }
  });

  it('pull 将远端原始字节落盘并写入同步状态', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-pull-'));
    tempDirs.push(root);
    const bytes = Buffer.from([0xff, 0x00, 0x61, 0xc3, 0x28]);
    const db = new SyncStateDb(path.join(root, 'state.db'));
    const remote = {
      getRootFileId: () => 'root',
      listFiles: async () => ({
        ok: true as const,
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
      readFileBuffer: async () => ({ ok: true as const, value: Buffer.from(bytes) }),
    } as unknown as RemoteFsAdapter;
    const local = new LocalFsAdapter(root, {
      filePatterns: ['**/*.md'],
      excludePatterns: ['state.db*'],
      syncDotFiles: false,
    });
    const engine = new SyncEngine(
      local,
      remote,
      db,
      {
        mappingId: 'pull-test',
        enabled: true,
        localRoot: root,
        syncDirection: 'pull',
        filePatterns: ['**/*.md'],
        excludePatterns: ['state.db*'],
      },
      { maxFileSizeBytes: 1024 },
    );

    try {
      const stats = await engine.runSync();
      assert.equal(stats.downloaded, 1);
      assert.equal(stats.failed, 0);
      assert.deepEqual(await readFile(path.join(root, 'doc.md')), bytes);
      assert.equal(db.getFileState('pull-test', 'doc.md')?.remoteFileId, 'remote-2');
    } finally {
      db.close();
    }
  });
});

describe('永久错误策略', () => {
  it('仅分类明确的鉴权、权限和参数错误', () => {
    assert.equal(classifyPermanentSyncFailure('HTTP 401: Unauthorized')?.category, 'authentication');
    assert.equal(classifyPermanentSyncFailure('API error 0: 权限不足')?.category, 'permission');
    assert.equal(classifyPermanentSyncFailure('HTTP 400: Bad Request')?.category, 'validation');
    assert.equal(classifyPermanentSyncFailure('HTTP 500: internal error'), null);
    assert.equal(classifyPermanentSyncFailure('文件信息查询失败'), null);
    assert.equal(classifyPermanentSyncFailure('EACCES: permission denied'), null);
    assert.equal(classifyPermanentSyncFailure('file id abc-401-def not found'), null);
    assert.equal(
      classifyPermanentSyncFailure('API error: permission denied')?.category,
      'permission',
    );
  });

  it('熔断冷却指数增长并受上限约束', () => {
    assert.equal(permanentCircuitDelayMs(1, 100, 1_000), 100);
    assert.equal(permanentCircuitDelayMs(3, 100, 1_000), 400);
    assert.equal(permanentCircuitDelayMs(99, 100, 1_000), 1_000);
  });

  it('熔断状态写入 SQLite 后可恢复和清除', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-circuit-db-'));
    const dbPath = path.join(root, 'state.db');
    try {
      const first = new SyncStateDb(dbPath);
      first.setMappingCircuitBreaker('mapping-a', 2, 123456, '权限不足');
      first.close();

      const reopened = new SyncStateDb(dbPath);
      assert.equal(reopened.getMappingState('mapping-a')?.circuitBreakerLevel, 2);
      assert.equal(reopened.getMappingState('mapping-a')?.circuitBreakerUntil, 123456);
      reopened.clearMappingCircuitBreaker('mapping-a');
      assert.equal(reopened.getMappingState('mapping-a')?.circuitBreakerUntil, null);
      reopened.setMappingCircuitBreaker('mapping-a', 3, 999999, '权限不足');
      reopened.resetMappingState('mapping-a');
      assert.equal(reopened.getMappingState('mapping-a')?.circuitBreakerUntil, null);
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('1.2.0 旧 SQLite 表可自动迁移熔断字段', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-circuit-migration-'));
    const dbPath = path.join(root, 'legacy.db');
    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE sync_mapping_state (
          mapping_id TEXT PRIMARY KEY,
          last_sync_since INTEGER,
          last_server_time INTEGER,
          last_success_at INTEGER,
          last_full_scan_at INTEGER,
          last_error TEXT,
          last_stats_json TEXT,
          resolved_root_file_id TEXT,
          resolved_project_id TEXT,
          index_file_remote_id TEXT,
          index_content_hash TEXT
        );
      `);
      legacy.close();

      const migrated = new SyncStateDb(dbPath);
      migrated.setMappingCircuitBreaker('legacy-mapping', 1, 888888, '权限不足');
      assert.equal(migrated.getMappingState('legacy-mapping')?.circuitBreakerLevel, 1);
      assert.equal(migrated.getMappingState('legacy-mapping')?.circuitBreakerUntil, 888888);
      migrated.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

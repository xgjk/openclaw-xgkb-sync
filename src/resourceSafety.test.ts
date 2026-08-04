import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { CentralReporter } from './centralReporter';
import { boundedPositiveInteger } from './config';
import {
  CENTRAL_EXECUTION_LOG_CONCURRENCY,
  CENTRAL_EXECUTION_LOG_MAX_PENDING,
} from './constants';
import { FileWatcher, SharedFileWatcherBackend } from './fileWatcher';
import type { KbApiClient } from './kbApi';
import { LocalFsAdapter } from './localFs';
import { RemoteFsAdapter } from './remoteFs';
import type { SyncScheduler } from './scheduler';
import { SyncEngine } from './syncEngine';
import { SyncStateDb } from './syncStateDb';
import type { MappingSyncRunResult, SyncConfig } from './types';

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
});

describe('共享文件监听语义', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

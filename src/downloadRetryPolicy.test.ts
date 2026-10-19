import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyDownloadFailure,
  gateDownloadRetry,
  nextDownloadFailureState,
} from './downloadRetryPolicy';
import { MAX_DOWNLOAD_ATTEMPTS } from './constants';
import type { FileState, RemoteFileEntry } from './types';

function remote(mtime = 1000): RemoteFileEntry {
  return {
    path: 'a.html',
    name: 'a.html',
    mtime,
    remoteFileId: 'rid-1',
    remoteFolderId: 'folder',
  };
}

function record(overrides: Partial<FileState> = {}): FileState {
  return {
    mappingId: 'm1',
    localPath: 'a.html',
    remoteFileId: 'rid-1',
    remoteFolderId: 'folder',
    remoteMtime: 1000,
    syncStatus: 'failed',
    downloadFailCount: 0,
    ...overrides,
  };
}

describe('classifyDownloadFailure', () => {
  it('权限不足 / 排队 / 超时禁止全文兜底', () => {
    assert.equal(classifyDownloadFailure('API error 0: 权限不足').allowFullContentFallback, false);
    assert.equal(classifyDownloadFailure('API error 0: 权限不足').failClass, 'permission');

    const queue = classifyDownloadFailure('高峰期下载排队等待中，剩余约 12 分钟');
    assert.equal(queue.failClass, 'queue');
    assert.equal(queue.allowFullContentFallback, false);
    assert.equal(queue.suggestedBackoffMs, 12 * 60_000);

    assert.equal(classifyDownloadFailure('请求超时(>30000ms)').failClass, 'timeout');
    assert.equal(classifyDownloadFailure('请求超时(>30000ms)').allowFullContentFallback, false);
  });

  it('硬拦截与超限立即分类', () => {
    assert.equal(classifyDownloadFailure('x ##HARD_BLOCK##').failClass, 'hard_block');
    assert.equal(
      classifyDownloadFailure('远端文件超过安全上限 10485760 bytes').failClass,
      'size_limit',
    );
  });
});

describe('nextDownloadFailureState / gateDownloadRetry', () => {
  it('累计到最大次数后放弃自动重试', () => {
    let failCount = 0;
    let abandoned = false;
    for (let i = 0; i < MAX_DOWNLOAD_ATTEMPTS; i++) {
      const next = nextDownloadFailureState({
        previousFailCount: failCount,
        errorMessage: '请求超时(>30000ms)',
        now: 1_000_000,
      });
      failCount = next.downloadFailCount;
      abandoned = next.abandoned;
    }
    assert.equal(failCount, MAX_DOWNLOAD_ATTEMPTS);
    assert.equal(abandoned, true);

    assert.equal(
      gateDownloadRetry({
        record: record({ downloadFailCount: MAX_DOWNLOAD_ATTEMPTS, remoteMtime: 1000 }),
        remote: remote(1000),
        now: 9_999_999,
      }),
      'abandon',
    );
  });

  it('退避未到期则 defer，到期可 proceed', () => {
    assert.equal(
      gateDownloadRetry({
        record: record({
          downloadFailCount: 2,
          downloadNextRetryAt: 2_000_000,
          remoteMtime: 1000,
        }),
        remote: remote(1000),
        now: 1_500_000,
      }),
      'defer',
    );
    assert.equal(
      gateDownloadRetry({
        record: record({
          downloadFailCount: 2,
          downloadNextRetryAt: 2_000_000,
          remoteMtime: 1000,
        }),
        remote: remote(1000),
        now: 2_000_001,
      }),
      'proceed',
    );
  });

  it('远端 mtime 推进后视为新版本，允许重新下载', () => {
    assert.equal(
      gateDownloadRetry({
        record: record({
          downloadFailCount: MAX_DOWNLOAD_ATTEMPTS,
          remoteMtime: 1000,
        }),
        remote: remote(5000),
        now: 9_999_999,
      }),
      'proceed',
    );
  });

  it('size_limit 一次即放弃', () => {
    const next = nextDownloadFailureState({
      previousFailCount: 0,
      errorMessage: '远端文件 999 bytes 超过安全上限 10 bytes',
    });
    assert.equal(next.abandoned, true);
    assert.equal(next.downloadFailCount, MAX_DOWNLOAD_ATTEMPTS);
  });
});

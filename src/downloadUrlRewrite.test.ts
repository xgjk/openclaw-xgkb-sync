import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it } from 'node:test';
import {
  getDownloadUrlRewriteDiskReadCount,
  resetDownloadUrlRewriteCache,
  rewriteDownloadUrl,
} from './downloadUrlRewrite';

function tempRewriteFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-rewrite-'));
  const filePath = path.join(dir, 'download-url-rewrites.json');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

afterEach(() => {
  resetDownloadUrlRewriteCache();
});

describe('rewriteDownloadUrl', () => {
  it('命中 from origin 时替换域名并保留 path/query', () => {
    const filePath = tempRewriteFile(
      JSON.stringify([
        {
          from: 'https://new-minio-cluster.meditube.hk',
          to: 'https://hk-al-minio.mediportal.com.cn',
        },
      ]),
    );

    const input =
      'https://new-minio-cluster.meditube.hk/bucket/key.pdf?X-Amz-Signature=abc&X-Amz-Expires=3600';
    const out = rewriteDownloadUrl(input, { filePath, now: 1_000 });
    assert.equal(
      out,
      'https://hk-al-minio.mediportal.com.cn/bucket/key.pdf?X-Amz-Signature=abc&X-Amz-Expires=3600',
    );
  });

  it('未命中时保持原 URL', () => {
    const filePath = tempRewriteFile(
      JSON.stringify([
        {
          from: 'https://new-minio-cluster.meditube.hk',
          to: 'https://hk-al-minio.mediportal.com.cn',
        },
      ]),
    );
    const input = 'https://other.example.com/a?b=1';
    assert.equal(rewriteDownloadUrl(input, { filePath, now: 1_000 }), input);
  });

  it('文件不存在时负缓存：TTL 内不重复读盘', () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'dl-rewrite-miss-')),
      'missing.json',
    );

    const url = 'https://new-minio-cluster.meditube.hk/x';
    assert.equal(rewriteDownloadUrl(url, { filePath, now: 1_000, ttlMs: 60_000 }), url);
    assert.equal(getDownloadUrlRewriteDiskReadCount(), 0);

    assert.equal(rewriteDownloadUrl(url, { filePath, now: 30_000, ttlMs: 60_000 }), url);
    assert.equal(getDownloadUrlRewriteDiskReadCount(), 0);
  });

  it('TTL 内有配置时只读盘一次', () => {
    const filePath = tempRewriteFile(
      JSON.stringify([
        {
          from: 'https://new-minio-cluster.meditube.hk',
          to: 'https://hk-al-minio.mediportal.com.cn',
        },
      ]),
    );

    const url = 'https://new-minio-cluster.meditube.hk/a';
    const expected = 'https://hk-al-minio.mediportal.com.cn/a';
    assert.equal(rewriteDownloadUrl(url, { filePath, now: 1_000, ttlMs: 60_000 }), expected);
    assert.equal(getDownloadUrlRewriteDiskReadCount(), 1);
    assert.equal(rewriteDownloadUrl(url, { filePath, now: 50_000, ttlMs: 60_000 }), expected);
    assert.equal(getDownloadUrlRewriteDiskReadCount(), 1);
  });

  it('TTL 到期且 mtime 变化后重新加载', () => {
    const filePath = tempRewriteFile(
      JSON.stringify([
        {
          from: 'https://new-minio-cluster.meditube.hk',
          to: 'https://hk-al-minio.mediportal.com.cn',
        },
      ]),
    );

    const url = 'https://new-minio-cluster.meditube.hk/a';
    assert.equal(
      rewriteDownloadUrl(url, { filePath, now: 1_000, ttlMs: 1_000 }),
      'https://hk-al-minio.mediportal.com.cn/a',
    );
    assert.equal(getDownloadUrlRewriteDiskReadCount(), 1);

    // 确保 mtime 可区分（部分 FS 精度为秒）
    const cur = fs.statSync(filePath).mtimeMs;
    fs.utimesSync(filePath, new Date(cur + 2000), new Date(cur + 2000));
    fs.writeFileSync(
      filePath,
      JSON.stringify([
        {
          from: 'https://new-minio-cluster.meditube.hk',
          to: 'https://other-minio.example.com',
        },
      ]),
      'utf-8',
    );

    assert.equal(
      rewriteDownloadUrl(url, { filePath, now: 5_000, ttlMs: 1_000 }),
      'https://other-minio.example.com/a',
    );
    assert.equal(getDownloadUrlRewriteDiskReadCount(), 2);
  });
});

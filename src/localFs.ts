import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { LocalDirEntry, LocalFileEntry } from './types';
import { canonicalizeRelativeSyncPath, normalizeSeparator, sanitizePathSegment } from './pathSanitize';
import {
  isInSyncScope,
  shouldSkipDotEntryName,
  type SyncScopeOptions,
} from './pathSyncScope';

/**
 * 本地文件系统适配器（Node.js 版）
 * 替代 Obsidian Vault API，面向标准 Node.js `fs/promises`。
 */
export class LocalFsAdapter {
  private readonly localRoot: string;
  private readonly scope: SyncScopeOptions;

  constructor(localRoot: string, scope: SyncScopeOptions) {
    this.localRoot = path.resolve(localRoot);
    this.scope = scope;
  }

  getRoot(): string {
    return this.localRoot;
  }

  getSyncScope(): SyncScopeOptions {
    return this.scope;
  }

  /**
   * 单次遍历同时采集文件与目录。按有限目录批次推进，避免宽目录树创建无界 Promise，
   * 也避免 SyncEngine 为同一棵树并行执行两次完整 walk。
   */
  async listSnapshot(): Promise<{ files: LocalFileEntry[]; directories: LocalDirEntry[] }> {
    const files: LocalFileEntry[] = [];
    const directories: LocalDirEntry[] = [];
    const pending: Array<{ absDir: string; relPrefix: string }> = [
      { absDir: this.localRoot, relPrefix: '' },
    ];
    const directoryBatchSize = 8;
    let pendingHead = 0;

    while (pendingHead < pending.length) {
      const batch = pending.slice(pendingHead, pendingHead + directoryBatchSize);
      pendingHead += batch.length;
      const discovered = await Promise.all(
        batch.map((item) => this.scanSnapshotDirectory(item.absDir, item.relPrefix, files, directories)),
      );
      for (const children of discovered) pending.push(...children);
      // 定期压缩已消费队列，兼顾线性 CPU 与路径对象及时释放。
      if (pendingHead >= 1_024) {
        pending.splice(0, pendingHead);
        pendingHead = 0;
      }
    }

    return { files, directories };
  }

  private async scanSnapshotDirectory(
    absDir: string,
    relPrefix: string,
    files: LocalFileEntry[],
    directories: LocalDirEntry[],
  ): Promise<Array<{ absDir: string; relPrefix: string }>> {
    let dirEntries: fsSync.Dirent[];
    try {
      dirEntries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const children: Array<{ absDir: string; relPrefix: string }> = [];
    for (const dirent of dirEntries) {
      if (shouldSkipDotEntryName(dirent.name, this.scope.syncDotFiles)) continue;
      const relPath = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
      const absPath = path.join(absDir, dirent.name);

      if (dirent.isDirectory()) {
        if (!isInSyncScope(relPath, this.scope, 'directory')) continue;
        const safePath = normalizeSeparator(relPath)
          .split('/')
          .map((seg) => sanitizePathSegment(seg))
          .join('/');
        try {
          const stat = await fs.stat(absPath, { bigint: true });
          directories.push({
            path: safePath,
            dev: stat.dev.toString(),
            ino: stat.ino.toString(),
          });
        } catch {
          directories.push({ path: safePath, dev: '0', ino: '0' });
        }
        children.push({ absDir: absPath, relPrefix: relPath });
        continue;
      }

      if (!dirent.isFile()) continue;
      const safePath = normalizeSeparator(relPath)
        .split('/')
        .map((seg) => sanitizePathSegment(seg))
        .join('/');
      if (!isInSyncScope(safePath, this.scope, 'file')) continue;
      try {
        const stat = await fs.stat(absPath, { bigint: true });
        files.push({
          path: safePath,
          name: dirent.name,
          mtime: Number(stat.mtimeMs),
          size: Number(stat.size),
          dev: stat.dev.toString(),
          ino: stat.ino.toString(),
        });
      } catch {
        // stat 失败跳过
      }
    }
    return children;
  }

  /**
   * 递归列出 localRoot 下所有匹配 filePatterns 且不在 excludePatterns 中的文件。
   * 返回路径均为相对于 localRoot 的路径（使用 "/" 分隔）。
   */
  async listFiles(): Promise<LocalFileEntry[]> {
    return (await this.listSnapshot()).files;
  }

  /**
   * 递归列出 localRoot 下所有纳入同步遍历范围的目录（含 dev/ino）。
   * 返回路径均为相对于 localRoot 的路径（使用 "/" 分隔），不包含根目录自身。
   */
  async listDirectories(): Promise<LocalDirEntry[]> {
    return (await this.listSnapshot()).directories;
  }

  /** 读取文件内容（UTF-8） */
  async readFile(relativePath: string): Promise<string> {
    const absPath = this.resolve(relativePath);
    return fs.readFile(absPath, 'utf-8');
  }

  async readFileBuffer(relativePath: string): Promise<Buffer> {
    return fs.readFile(this.resolve(relativePath));
  }

  /**
   * 写入文件（自动创建父目录）。
   * 返回写入后的实际 mtime。
   */
  async writeFile(relativePath: string, content: string): Promise<number> {
    const absPath = this.resolve(relativePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
    const stat = await fs.stat(absPath);
    return stat.mtimeMs;
  }

  async writeFileBuffer(relativePath: string, content: Buffer): Promise<number> {
    const absPath = this.resolve(relativePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content);
    const stat = await fs.stat(absPath);
    return stat.mtimeMs;
  }

  /**
   * 删除文件。
   * 若路径不存在则静默跳过。
   */
  async deleteFile(relativePath: string): Promise<void> {
    const absPath = this.resolve(relativePath);
    try {
      await fs.unlink(absPath);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  /** 获取文件的 mtime（毫秒），不存在返回 null */
  async getMtime(relativePath: string): Promise<number | null> {
    const absPath = this.resolve(relativePath);
    try {
      const stat = await fs.stat(absPath);
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * 重命名文件或目录（原子移动操作，源和目标必须在同一文件系统）。
   * 若目标已存在则会被覆盖（平台行为）。
   * 自动创建目标路径的父目录。
   */
  async rename(fromRelPath: string, toRelPath: string): Promise<void> {
    const fromAbs = this.resolve(fromRelPath);
    const toAbs = this.resolve(toRelPath);
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
  }

  /** 判断文件是否存在 */
  async exists(relativePath: string): Promise<boolean> {
    const absPath = this.resolve(relativePath);
    try {
      await fs.access(absPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 将相对路径解析为绝对路径，并验证结果在 localRoot 内（防路径穿越）。
   * 若解析结果逃逸出 localRoot，抛出错误而非静默处理。
   */
  resolve(relativePath: string): string {
    const safe = canonicalizeRelativeSyncPath(normalizeSeparator(relativePath));
    const resolved = path.resolve(this.localRoot, safe);
    const rootWithSep = this.localRoot.endsWith(path.sep)
      ? this.localRoot
      : this.localRoot + path.sep;
    if (resolved !== this.localRoot && !resolved.startsWith(rootWithSep)) {
      throw new Error(`路径越界: "${relativePath}" 解析后超出 localRoot 范围`);
    }
    return resolved;
  }
}

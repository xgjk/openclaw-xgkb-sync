import { KbApiClient } from './kbApi';
import { FileUploader } from './fileUploader';
import { normalizeMoveFileResult, warnMoveFileResponseGaps } from './kbMoveFileContract';
import { normalizeUpdateFileNameResult } from './kbRenameFileContract';
import {
  ApiResult,
  FileListItem,
  FileMeta,
  ListChangesItem,
  MoveFileParams,
  MoveFileResult,
  RemoteFileEntry,
  UpdateFileNameParams,
  UpdateFileNameResult,
} from './types';
import {
  BATCH_GET_META_MAX,
  DEFAULT_FILE_PATTERNS,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_SYNC_DOT_FILES,
  DOWNLOAD_CONCURRENCY,
  MAX_SYNC_ERROR_DETAILS,
  REQUEST_TIMEOUT_MS,
  buildListDescendantFilesSuffix,
} from './constants';
import { canonicalizeRelativeSyncPath, sanitizePathSegment } from './pathSanitize';
import { isRemotePathInSyncScope, type SyncScopeOptions } from './pathSyncScope';

export interface RemoteFsOptions {
  /** 日志上下文；Scheduler 传入 mappingId，便于并发同步时归因。 */
  mappingId?: string;
  /** Knowledge base project ID. If omitted, init() resolves the personal project ID. */
  projectId?: string;
  /**
   * Remote root folder fileId. If omitted, it can be resolved from remoteRootFolderPath.
   * If both fields are omitted, the mapping targets the project root.
   */
  remoteRootFileId?: string;
  /**
   * Remote root folder path, separated by "/"; for example "OpenClaw/OutputA".
   * Also used as the folderName prefix for uploadContent.
   */
  remoteRootFolderPath?: string;
  /** Cached rootFileId from SQLite, passed by Scheduler. */
  cachedRootFileId?: string;
  /** Cached projectId from SQLite, passed by Scheduler. */
  cachedProjectId?: string;
  /** File include patterns, used for API suffix inference and client-side filtering. */
  filePatterns?: string[];
  /** File exclude patterns, used for client-side filtering. */
  excludePatterns?: string[];
  /** Whether dot-segment paths participate in remote list filtering. */
  syncDotFiles?: boolean;
  /** 下载/上传正文的单文件内存安全上限。 */
  maxFileSizeBytes?: number;
}

/** Resolved IDs returned by init() for Scheduler to persist. */
export interface RemoteFsInitResult {
  projectId: string;
  rootFileId: string;
  rootFolderPath: string;
}

export interface PruneEmptyDirectoriesResult {
  deleted: number;
  failed: number;
  errors: string[];
}

interface PruneFolderResult extends PruneEmptyDirectoriesResult {
  existsAfter: boolean;
}

/**
 * Remote knowledge-base filesystem adapter for OpenClaw.
 * Handles root resolution, listing, downloads, uploads, and deletes.
 */
export class RemoteFsAdapter {
  private readonly api: KbApiClient;
  private readonly uploader: FileUploader;
  private readonly opts: RemoteFsOptions;
  private readonly syncScope: SyncScopeOptions;

  // Resolved by init().
  private resolvedProjectId: string | null = null;
  private resolvedRootFileId: string | null = null;
  private resolvedRootFolderPath: string | null = null;
  private readonly maxFileSizeBytes: number;
  private readonly logPrefix: string;

  constructor(api: KbApiClient, opts: RemoteFsOptions) {
    this.api = api;
    this.uploader = new FileUploader(api);
    this.opts = opts;
    this.logPrefix = opts.mappingId ? `[RemoteFs][${opts.mappingId}]` : '[RemoteFs]';
    this.syncScope = {
      filePatterns: opts.filePatterns ?? DEFAULT_FILE_PATTERNS,
      excludePatterns: opts.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS,
      syncDotFiles: opts.syncDotFiles ?? DEFAULT_SYNC_DOT_FILES,
    };
    this.maxFileSizeBytes = opts.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  }

  getRootFileId(): string {
    if (!this.resolvedRootFileId) throw new Error('RemoteFsAdapter is not initialized; call init() first');
    return this.resolvedRootFileId;
  }

  getProjectId(): string {
    if (!this.resolvedProjectId) throw new Error('RemoteFsAdapter is not initialized; call init() first');
    return this.resolvedProjectId;
  }

  getRootFolderPath(): string {
    return this.resolvedRootFolderPath ?? '';
  }

  /**
   * Resolve projectId and rootFileId with priority:
   * explicit config > SQLite cache > API lookup.
   */
  async init(): Promise<ApiResult<RemoteFsInitResult>> {
    // 1. projectId: explicit config, then cache, then personal project API.
    let projectId = this.opts.projectId ?? this.opts.cachedProjectId ?? null;

    if (!projectId) {
      console.log(`${this.logPrefix} projectId missing; calling getPersonalProjectId()...`);
      const r = await this.api.getPersonalProjectId();
      if (!r.ok) return { ok: false, error: `Failed to get personal project ID: ${r.error}` };
      projectId = r.value;
      console.log(`${this.logPrefix} Resolved personal project ID: ${projectId}`);
    }
    this.resolvedProjectId = projectId;

    // 2. rootFileId: explicit config, then cache, then path resolution or project root.
    let rootFileId = this.opts.remoteRootFileId ?? this.opts.cachedRootFileId ?? null;

    if (!rootFileId) {
      if (this.opts.remoteRootFolderPath) {
        console.log(`${this.logPrefix} remoteRootFileId missing; resolving path: "${this.opts.remoteRootFolderPath}"`);
        const r = await this.resolveFileIdFromPath(this.opts.remoteRootFolderPath, projectId);
        if (!r.ok) return r;
        rootFileId = r.value;
        console.log(`${this.logPrefix} Path resolved: rootFileId=${rootFileId}`);
      } else {
        // Both root fields omitted: target the project root.
        rootFileId = '0';
        console.log(`${this.logPrefix} remote root not configured; using project root (rootFileId=0)`);
      }
    }
    this.resolvedRootFileId = rootFileId;

    // 3. rootFolderPath is used as uploadContent folderName prefix.
    if (this.opts.remoteRootFolderPath) {
      this.resolvedRootFolderPath = this.opts.remoteRootFolderPath;
    } else if (rootFileId === '0') {
      this.resolvedRootFolderPath = '';
    } else if (!this.resolvedRootFolderPath) {
      console.log(`${this.logPrefix} remoteRootFolderPath missing; resolving path with batchGetMeta...`);
      const r = await this.resolvePathFromFileId(rootFileId);
      if (!r.ok) return r;
      this.resolvedRootFolderPath = r.value;
      console.log(`${this.logPrefix} Reverse path resolved: "${this.resolvedRootFolderPath}"`);
    }

    return {
      ok: true,
      value: {
        projectId,
        rootFileId,
        rootFolderPath: this.resolvedRootFolderPath ?? '',
      },
    };
  }

  /**
   * Resolve a remote folder path to fileId.
   * Example resolveFileIdFromPath("OpenClaw/OutputA", projectId):
   * - getLevel1Folders finds "OpenClaw"(id=100)
   * - getChildFiles(100, type=1) finds "OutputA"(id=200)
   * - returns "200"
   */
  private async resolveFileIdFromPath(
    folderPath: string,
    projectId: string,
  ): Promise<ApiResult<string>> {
    const segments = folderPath.split('/').filter(Boolean);
    if (segments.length === 0) {
      return { ok: false, error: `remoteRootFolderPath is empty: "${folderPath}"` };
    }

    const level1Result = await this.api.getLevel1Folders(projectId);
    if (!level1Result.ok) {
      return { ok: false, error: `Failed to get level-1 folders: ${level1Result.error}` };
    }

    const folders = level1Result.value ?? [];
    const firstSeg = segments[0];
    let firstFolder = folders.find((f) => f.name === firstSeg && f.type === 1);

    if (!firstFolder) {
      const createResult = await this.api.createFolder({ projectId, parentId: '0', name: firstSeg });
      if (!createResult.ok) {
        return { ok: false, error: `Failed to create level-1 folder "${firstSeg}": ${createResult.error}` };
      }
      firstFolder = { id: Number(createResult.value), name: firstSeg, type: 1 };
    }

    let currentId = String(firstFolder.id);

    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const childResult = await this.api.getChildFiles(currentId, 1);
      if (!childResult.ok) {
        return { ok: false, error: `Failed to get child folders(parentId=${currentId}): ${childResult.error}` };
      }

      const children = childResult.value ?? [];
      const found = children.find((f) => f.name === seg);
      if (!found) {
        const parentPath = segments.slice(0, i).join('/');
        const createResult = await this.api.createFolder({ projectId, parentId: currentId, name: seg });
        if (!createResult.ok) {
          return { ok: false, error: `Failed to create folder "${seg}" under "${parentPath}": ${createResult.error}` };
        }
        currentId = String(createResult.value);
      } else {
        currentId = String(found.id);
      }
    }

    return { ok: true, value: currentId };
  }

  /**
   * 将「相对 mapping 根」的本地目录路径解析为远端 folderId。
   * 空字符串表示 mapping 根（resolvedRootFileId）。
   * @param createIfMissing true=路径不存在时逐级 createFolder（上传流程）；
   *                        false=只查找不创建，找不到返回 error（enrichment 阶段使用）。
   */
  async resolveFolderIdForLocalDir(
    localDirPath: string,
    createIfMissing = true,
  ): Promise<ApiResult<string>> {
    if (!this.resolvedRootFileId || !this.resolvedProjectId) {
      return { ok: false, error: 'RemoteFsAdapter is not initialized; call init() first' };
    }

    const segments = localDirPath.split('/').filter(Boolean);
    if (segments.length === 0) {
      return { ok: true, value: this.resolvedRootFileId };
    }

    let currentId = this.resolvedRootFileId;

    for (const seg of segments) {
      const childResult = await this.api.getChildFiles(currentId, 1);
      if (!childResult.ok) {
        return {
          ok: false,
          error: `getChildFiles(parentId=${currentId}) failed: ${childResult.error}`,
        };
      }

      const children = childResult.value ?? [];
      const found = children.find((f) => f.name === seg && f.type === 1);
      if (!found) {
        if (!createIfMissing) {
          return { ok: false, error: `folder "${seg}" not found (lookup-only mode)` };
        }
        const createResult = await this.api.createFolder({
          projectId: this.resolvedProjectId,
          parentId: currentId,
          name: seg,
        });
        if (!createResult.ok) {
          return {
            ok: false,
            error: `createFolder "${seg}" failed: ${createResult.error}`,
          };
        }
        currentId = String(createResult.value);
      } else {
        currentId = String(found.id);
      }
    }

    return { ok: true, value: currentId };
  }

  /**
   * Resolve a folder path from fileId for configs that only provide remoteRootFileId.
   */
  private async resolvePathFromFileId(fileId: string): Promise<ApiResult<string>> {
    const segments: string[] = [];
    let currentId = fileId;
    const MAX_DEPTH = 15;
    let reachedMaxDepth = true;

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const metaMap = await this.batchGetMetaAll([currentId]);
      const meta = metaMap.get(currentId);
      if (!meta) {
        return { ok: false, error: `Failed to get file metadata: fileId=${currentId}` };
      }

      segments.unshift(meta.name);
      const parentId = meta.parentId != null ? String(meta.parentId) : '0';
      if (parentId === '0' || !parentId) {
        reachedMaxDepth = false;
        break;
      }

      currentId = parentId;
    }

    if (reachedMaxDepth) {
      console.warn(
        `${this.logPrefix} resolvePathFromFileId reached max depth (${MAX_DEPTH}); path may be incomplete: "${segments.join('/')}"`,
      );
    }

    return { ok: true, value: segments.join('/') };
  }

  /**
   * Full remote listing via paginated listDescendantFiles.
   * suffix is inferred from filePatterns (single ext / comma-separated / `*`);
   * client-side filePatterns filtering always applied afterward.
   */
  async listFiles(): Promise<ApiResult<RemoteFileEntry[]>> {
    const entries: RemoteFileEntry[] = [];
    let cursor: string | undefined;
    let page = 0;

    const apiSuffix = buildListDescendantFilesSuffix(this.syncScope.filePatterns);

    do {
      page++;
      const r = await this.api.listDescendantFiles({
        rootFileId: this.resolvedRootFileId!,  // '0' means project root.
        projectId: this.resolvedProjectId!,
        suffix: apiSuffix,
        limit: 500,
        cursor,
        includePath: true,
      });

      if (!r.ok) return { ok: false, error: r.error };

      const pageItems = r.value.files ?? [];
      for (const item of pageItems) {
        const rawPath = item.relativePath ?? item.name;
        const safePath = canonicalizeRelativeSyncPath(rawPath);

        // Even with API suffix filtering, still apply full include/exclude/syncDot scope locally.
        if (!isRemotePathInSyncScope(safePath, this.syncScope)) continue;

        entries.push({
          path: safePath,
          name: item.name,
          mtime: item.updateTime ?? 0,
          size: item.size,
          remoteFileId: String(item.fileId),
          remoteFolderId: item.parentId != null ? String(item.parentId) : '',
        });
      }

      cursor = r.value.nextCursor ?? undefined;
    } while (cursor);

    console.log(
      `${this.logPrefix} listDescendantFiles done: files=${entries.length} pages=${page} suffix=${apiSuffix}`,
    );
    return { ok: true, value: entries };
  }

  /**
   * Read remote file content.
   * Prefer getDownloadInfo(forceDownload=true) OSS URL; fall back to getFullFileContent.
   */
  async readFile(fileId: string): Promise<ApiResult<string>> {
    const result = await this.readFileBuffer(fileId);
    return result.ok ? { ok: true, value: result.value.toString('utf8') } : result;
  }

  /** 主同步下载使用 Buffer，避免 Response→UTF-16 string→Buffer 的整文件双重复制。 */
  async readFileBuffer(fileId: string): Promise<ApiResult<Buffer>> {
    const infoResult = await this.api.getDownloadInfo(fileId, true);
    if (infoResult.ok && infoResult.value.downloadUrl) {
      if (
        infoResult.value.size != null &&
        Number(infoResult.value.size) > this.maxFileSizeBytes
      ) {
        return {
          ok: false,
          error: `远端文件 ${infoResult.value.size} bytes 超过安全上限 ${this.maxFileSizeBytes} bytes`,
        };
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 2);
      try {
        const resp = await fetch(infoResult.value.downloadUrl, { signal: controller.signal });
        if (!resp.ok) {
          return {
            ok: false,
            error: `OSS download failed HTTP ${resp.status}: ${resp.statusText}`,
          };
        }
        const contentLength = Number(resp.headers.get('content-length') ?? 0);
        if (contentLength > this.maxFileSizeBytes) {
          controller.abort();
          return {
            ok: false,
            error: `远端文件 ${contentLength} bytes 超过安全上限 ${this.maxFileSizeBytes} bytes`,
          };
        }
        return this.readResponseBufferLimited(resp, controller);
      } catch (e) {
        return {
          ok: false,
          error: `OSS download error: ${e instanceof Error ? e.message : String(e)}`,
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    console.warn(
      `${this.logPrefix} getDownloadInfo falling back to getFullFileContent (fileId=${fileId}): ` +
        `${infoResult.ok ? 'no downloadUrl' : infoResult.error}`,
    );
    const fallback = await this.api.getFullFileContent(fileId);
    if (!fallback.ok) return fallback;
    const cleaned =
      fallback.value == null
        ? ''
        : fallback.value.replace(/\n*Page \d+ of \d+\s*$/, '').trimEnd() + '\n';
    const value = Buffer.from(cleaned, 'utf8');
    if (value.length > this.maxFileSizeBytes) {
      return {
        ok: false,
        error: `远端文件 ${value.length} bytes 超过安全上限 ${this.maxFileSizeBytes} bytes`,
      };
    }
    return { ok: true, value };
  }

  private async readResponseBufferLimited(
    resp: Response,
    controller: AbortController,
  ): Promise<ApiResult<Buffer>> {
    if (!resp.body) return { ok: true, value: Buffer.alloc(0) };
    const reader = resp.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxFileSizeBytes) {
          controller.abort();
          return {
            ok: false,
            error: `远端文件超过安全上限 ${this.maxFileSizeBytes} bytes，已中止下载`,
          };
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
      if (chunks.length === 0) return { ok: true, value: Buffer.alloc(0) };
      if (chunks.length === 1) return { ok: true, value: chunks[0] };
      return { ok: true, value: Buffer.concat(chunks, total) };
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Batch-read file content through getDownloadInfo + OSS fetch.
   * Single-file failures are warned here; callers can retry on cache miss.
   */
  async readFilesBatch(fileIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(fileIds.filter(Boolean))];
    let failureCount = 0;
    const failureSamples: string[] = [];

    const downloadOne = async (fileId: string): Promise<void> => {
      const r = await this.readFile(fileId);
      if (r.ok) {
        out.set(fileId, r.value ?? '');
      } else {
        failureCount++;
        if (failureSamples.length < 5) failureSamples.push(`${fileId}: ${r.error}`);
      }
    };

    for (let i = 0; i < unique.length; i += DOWNLOAD_CONCURRENCY) {
      const chunk = unique.slice(i, i + DOWNLOAD_CONCURRENCY);
      await Promise.all(chunk.map(downloadOne));
    }

    if (failureCount > 0) {
      console.warn(
        `${this.logPrefix} batch download failed=${failureCount}/${unique.length}` +
          ` samples=${JSON.stringify(failureSamples)}`,
      );
    }

    return out;
  }

  /**
   * Create a remote file (new upload, no existing fileId).
   * @param relativePath Relative path, for example "folder/2024.md".
   */
  async createFile(
    relativePath: string,
    content: string | Buffer,
  ): Promise<ApiResult<{ remoteFileId: string; remoteFolderId: string }>> {
    const contentBytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
    if (contentBytes > this.maxFileSizeBytes) {
      return {
        ok: false,
        error: `本地文件 ${contentBytes} bytes 超过安全上限 ${this.maxFileSizeBytes} bytes`,
      };
    }
    if (this.resolvedRootFolderPath === null) {
      return { ok: false, error: 'RemoteFsAdapter is not initialized; call init() first' };
    }

    const lastSlash = relativePath.lastIndexOf('/');
    const subPath = lastSlash > 0 ? relativePath.substring(0, lastSlash) : '';
    const fileName = lastSlash > 0 ? relativePath.substring(lastSlash + 1) : relativePath;
    const fileSuffix = getFileSuffix(fileName);

    let folderName: string;
    if (this.resolvedRootFolderPath) {
      folderName = subPath
        ? `${this.resolvedRootFolderPath}/${subPath}`
        : this.resolvedRootFolderPath;
    } else {
      folderName = subPath;
    }

    return this.uploader.create({ content, fileName, fileSuffix, folderName, projectId: this.resolvedProjectId! });
  }

  /**
   * Update a remote file version (append new version to existing fileId).
   */
  async updateFile(
    remoteFileId: string,
    fileName: string,
    content: string | Buffer,
  ): Promise<ApiResult<string>> {
    const contentBytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
    if (contentBytes > this.maxFileSizeBytes) {
      return {
        ok: false,
        error: `本地文件 ${contentBytes} bytes 超过安全上限 ${this.maxFileSizeBytes} bytes`,
      };
    }
    const fileSuffix = getFileSuffix(fileName);
    const r = await this.uploader.update({
      content,
      fileName,
      fileSuffix,
      updateFileId: remoteFileId,
      projectId: this.resolvedProjectId ?? undefined,
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, value: r.value.remoteFileId };
  }

  /**
   * 重命名远端文件或文件夹（同目录内改名，不移动）。
   * 对应 KB v2 updateFileName 接口。
   */
  async renameFile(params: UpdateFileNameParams): Promise<ApiResult<UpdateFileNameResult>> {
    const rootFileId = params.rootFileId ?? this.resolvedRootFileId ?? undefined;
    const r = await this.api.updateFileName({
      fileId: params.fileId,
      newName: params.newName,
      nameConflictStrategy: params.nameConflictStrategy,
      projectId: params.projectId ?? this.resolvedProjectId ?? undefined,
      rootFileId,
    });
    if (!r.ok) return { ok: false, error: `renameFile 失败: ${r.error}` };
    return {
      ok: true,
      value: normalizeUpdateFileNameResult(r.value, params.fileId),
    };
  }

  /**
   * 移动远端节点。同步侧不传 newName（换目录+改名时由调用方先 move 再 updateFileName）。
   */
  async moveFile(params: MoveFileParams): Promise<ApiResult<MoveFileResult>> {
    const rootFileId = params.rootFileId ?? this.resolvedRootFileId ?? undefined;
    const r = await this.api.moveFile({
      fileId: params.fileId,
      targetParentId: params.targetParentId,
      nameConflictStrategy: params.nameConflictStrategy,
      projectId: params.projectId ?? this.resolvedProjectId ?? undefined,
      rootFileId,
    });
    if (!r.ok) return { ok: false, error: `moveFile 失败: ${r.error}` };
    const value = normalizeMoveFileResult(r.value, params.fileId);
    warnMoveFileResponseGaps(value, params.fileId, rootFileId != null, 'RemoteFs');
    return { ok: true, value };
  }

  /** Delete remote file. */
  async deleteFile(remoteFileId: string): Promise<ApiResult<void>> {
    const r = await this.api.deleteFile(remoteFileId);
    if (!r.ok) return r;
    return { ok: true, value: undefined };
  }

  /** 查询远端目录的直接子项（文件+子目录），用于安全检查目录是否为空 */
  async getChildFiles(folderId: string): Promise<ApiResult<FileListItem[]>> {
    return this.api.getChildFiles(folderId);
  }

  /**
   * 在指定目录的直接子项中按文件名查找文件（type≠1）的 fileId。
   * 用于 Pull 端 consume 索引冷启动 locate。
   */
  async findDirectChildFileId(
    parentFolderId: string,
    fileName: string,
  ): Promise<ApiResult<string | null>> {
    const r = await this.api.getChildFiles(parentFolderId);
    if (!r.ok) return { ok: false, error: r.error };
    const item = (r.value ?? []).find((c) => c.name === fileName && c.type !== 1);
    return { ok: true, value: item != null ? String(item.id) : null };
  }

  /** uploadContent 封装（自动注入 projectId） */
  async uploadTextContent(params: {
    content: string;
    fileName: string;
    fileSuffix?: string;
    folderName?: string;
    updateFileId?: string;
  }): Promise<ApiResult<{ fileId: string | number }>> {
    const contentBytes = Buffer.byteLength(params.content, 'utf8');
    if (contentBytes > this.maxFileSizeBytes) {
      return {
        ok: false,
        error: `索引文件 ${contentBytes} bytes 超过安全上限 ${this.maxFileSizeBytes} bytes`,
      };
    }
    return this.api.uploadContent({
      content: params.content,
      fileName: params.fileName,
      fileSuffix: params.fileSuffix,
      folderName: params.folderName,
      updateFileId: params.updateFileId,
      projectId: this.resolvedProjectId!,
    });
  }

  /**
   * 后序清理远端空目录。
   * - 不删除 mapping 根目录自身；
   * - 若本地仍存在同名目录，即使为空也保留；
   * - 只删除知识库中真正没有任何子项的目录，避免误删含非同步文件的目录。
   */
  async pruneEmptyDirectories(
    localDirectoryPaths: Set<string>,
  ): Promise<ApiResult<PruneEmptyDirectoriesResult>> {
    if (!this.resolvedRootFileId) {
      return { ok: false, error: 'RemoteFsAdapter is not initialized; call init() first' };
    }

    const result = await this.pruneFolderNode(
      this.resolvedRootFileId,
      '',
      localDirectoryPaths,
      true,
    );

    return {
      ok: true,
      value: {
        deleted: result.deleted,
        failed: result.failed,
        errors: result.errors,
      },
    };
  }

  private async pruneFolderNode(
    folderId: string,
    relPath: string,
    localDirectoryPaths: Set<string>,
    isRoot: boolean,
  ): Promise<PruneFolderResult> {
    const childrenResult = await this.api.getChildFiles(folderId);
    if (!childrenResult.ok) {
      return {
        existsAfter: true,
        deleted: 0,
        failed: 1,
        errors: [`${relPath || '<root>'}: list children failed: ${childrenResult.error}`],
      };
    }

    let deleted = 0;
    let failed = 0;
    const errors: string[] = [];
    let hasChildAfterPrune = false;

    for (const child of childrenResult.value ?? []) {
      const childId = String(child.id);
      if (child.type !== 1) {
        hasChildAfterPrune = true;
        continue;
      }

      const childRelPath = relPath
        ? `${relPath}/${sanitizePathSegment(child.name)}`
        : sanitizePathSegment(child.name);
      const childResult = await this.pruneFolderNode(
        childId,
        childRelPath,
        localDirectoryPaths,
        false,
      );
      deleted += childResult.deleted;
      failed += childResult.failed;
      const remainingErrorSlots = MAX_SYNC_ERROR_DETAILS - errors.length;
      if (remainingErrorSlots > 0) {
        errors.push(...childResult.errors.slice(0, remainingErrorSlots));
      }
      if (childResult.existsAfter) {
        hasChildAfterPrune = true;
      }
    }

    if (isRoot || hasChildAfterPrune || localDirectoryPaths.has(relPath)) {
      return { existsAfter: true, deleted, failed, errors };
    }

    const deleteResult = await this.api.deleteFile(folderId);
    if (!deleteResult.ok) {
      return {
        existsAfter: true,
        deleted,
        failed: failed + 1,
        errors: [...errors, `${relPath}: delete empty folder failed: ${deleteResult.error}`],
      };
    }

    return { existsAfter: false, deleted: deleted + 1, failed, errors };
  }

  /**
   * Incremental change listing through listChanges.
   * @param since Last successful sync watermark.
   */
  async listAllChanges(
    since: number,
  ): Promise<ApiResult<{ items: ListChangesItem[]; serverTime?: number }>> {
    const allItems: ListChangesItem[] = [];
    let cursor: string | undefined;
    let serverTime: number | undefined;
    let page = 0;

    do {
      page++;
      const r = await this.api.listChanges({
        projectId: this.resolvedProjectId!,
        // rootFileId='0' means project root; omit rootFileId to scan the whole project.
        ...(this.resolvedRootFileId !== '0' && { rootFileId: this.resolvedRootFileId! }),
        since: cursor ? undefined : since,
        cursor,
        limit: 200,
      });

      if (!r.ok) return { ok: false, error: r.error };

      const pageItems = r.value.items ?? [];
      allItems.push(...pageItems);
      serverTime = r.value.serverTime ?? serverTime;
      cursor = r.value.nextCursor ?? undefined;
    } while (cursor);

    let upsertCount = 0;
    let deleteCount = 0;
    for (const item of allItems) {
      if (item.event === 'delete') deleteCount++;
      else upsertCount++;
    }
    if (allItems.length > 0 || page > 1) {
      console.log(
        `${this.logPrefix} listChanges done: items=${allItems.length}` +
          ` upsert=${upsertCount} delete=${deleteCount} pages=${page} serverTime=${serverTime}`,
      );
    }

    return { ok: true, value: { items: allItems, serverTime } };
  }

  /**
   * Batch metadata lookup through batchGetMeta, returning fileId -> FileMeta.
   * Failed batches are warned and skipped; callers handle missing metadata.
   */
  async batchGetMetaAll(fileIds: string[]): Promise<Map<string, FileMeta>> {
    const out = new Map<string, FileMeta>();
    const unique = [...new Set(fileIds.filter(Boolean))];
    let failedBatches = 0;
    let deletedTotal = 0;

    for (let i = 0; i < unique.length; i += BATCH_GET_META_MAX) {
      const chunk = unique.slice(i, i + BATCH_GET_META_MAX);
      const r = await this.api.batchGetMeta(chunk, this.resolvedProjectId!);

      if (!r.ok) {
        failedBatches++;
        if (failedBatches <= 3) {
          console.warn(
            `${this.logPrefix} batchGetMeta batch=${Math.floor(i / BATCH_GET_META_MAX) + 1} failed: ${r.error}`,
          );
        }
        continue;
      }

      for (const item of r.value ?? []) {
        out.set(String(item.fileId), item);
        if (item.deleted) deletedTotal++;
      }
    }

    const missingCount = unique.length - out.size;
    if (unique.length >= BATCH_GET_META_MAX || missingCount > 0 || failedBatches > 0) {
      console.log(
        `${this.logPrefix} batchGetMeta done: requested=${unique.length} hit=${out.size}` +
          ` missing=${missingCount} deleted=${deletedTotal} failedBatches=${failedBatches}`,
      );
    }
    if (failedBatches > 3) {
      console.warn(`${this.logPrefix} batchGetMeta 另有 ${failedBatches - 3} 个失败批次未逐条输出`);
    }

    return out;
  }
}

function getFileSuffix(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return undefined;
  return fileName.slice(dot + 1).toLowerCase();
}

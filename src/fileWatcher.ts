import * as fs from 'fs';
import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import {
  FILE_INDEX_NAME,
  MAX_NATIVE_RECURSIVE_WATCH_ROOTS,
  MAX_PENDING_WATCH_PATHS,
  WATCH_AWAIT_WRITE_POLL_MS,
  WATCH_AWAIT_WRITE_STABILITY_MS,
  WATCH_PULL_IGNORE_TAIL_MS,
} from './constants';
import { canonicalizeRelativeSyncPath, normalizeSeparator } from './pathSanitize';
import { isInSyncScope, shouldSkipDotEntryName, type SyncScopeOptions } from './pathSyncScope';

export type FileWatcherBackendMode =
  | 'darwin-native-recursive'
  | 'chokidar'
  | 'chokidar-polling';

function isPathWithin(candidate: string, ancestor: string): boolean {
  const rel = path.relative(path.resolve(ancestor), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 去掉完全重复和被父目录覆盖的 root，避免为嵌套 mapping 重复建立递归 watcher。 */
export function compactWatchRoots(roots: Iterable<string>): string[] {
  const unique = [...new Set([...roots].map((root) => path.resolve(root)))].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  const compact: string[] = [];
  for (const root of unique) {
    if (!compact.some((parent) => isPathWithin(root, parent))) compact.push(root);
  }
  return compact;
}

export interface FileWatcherOptions {
  mappingId: string;
  localRoot: string;
  scope: SyncScopeOptions;
  debounceMs: number;
  usePolling: boolean;
  onBatchReady: (pathCount: number) => void;
}

/**
 * 多 mapping 共用的底层 chokidar 实例。
 *
 * chokidar 的每个 FSWatcher 都会维护一套完整的目录/文件索引；将多个 root 放进同一实例
 * 可自动去重父子/重叠目录，同时仍由 FileWatcher 保留 mapping 级 debounce、pause、ignore 语义。
 * polling 与非 polling 的底层机制不同，由 Scheduler 分成最多两个 backend。
 */
export class SharedFileWatcherBackend {
  private readonly registrations = new Map<string, FileWatcher>();
  private watcher: FSWatcher | null = null;
  private readonly nativeWatchers = new Map<string, fs.FSWatcher>();
  private droppedRootCount = 0;
  private readyPromise: Promise<void> = Promise.resolve();
  private resolveReady: (() => void) | null = null;

  constructor(
    private readonly usePolling: boolean,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  register(registration: FileWatcher): void {
    this.registrations.set(registration.getMappingId(), registration);
  }

  unregister(mappingId: string): void {
    this.registrations.delete(mappingId);
  }

  start(): void {
    if (this.isActive() || this.registrations.size === 0) return;
    const roots = compactWatchRoots(
      [...this.registrations.values()].map((registration) => registration.getResolvedRoot()),
    );
    if (roots.length === 0) return;

    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });

    if (this.getMode() === 'darwin-native-recursive') {
      this.startDarwinNativeWatchers(roots);
      this.resolveReady?.();
      this.resolveReady = null;
      return;
    }

    this.watcher = chokidar.watch(roots, {
      ignored: (absPath, stats) => {
        for (const registration of this.registrations.values()) {
          if (!registration.shouldIgnoreSharedTarget(absPath, stats)) return false;
        }
        return true;
      },
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: WATCH_AWAIT_WRITE_STABILITY_MS,
        pollInterval: WATCH_AWAIT_WRITE_POLL_MS,
      },
      usePolling: this.usePolling,
      depth: undefined,
    });

    this.watcher.on('all', (event, absPath) => {
      for (const registration of this.registrations.values()) {
        registration.handleSharedFsEvent(event, absPath);
      }
    });
    this.watcher.on('ready', () => {
      this.resolveReady?.();
      this.resolveReady = null;
      console.log(
        `[FileWatcher] shared backend ready mappings=${this.registrations.size}` +
          ` roots=${roots.length} polling=${this.usePolling}`,
      );
    });
    this.watcher.on('error', (err) => {
      console.warn(
        `[FileWatcher] shared backend error polling=${this.usePolling}: ` +
          `${err instanceof Error ? err.message : String(err)}; 依赖定时 sync 兜底`,
      );
    });
  }

  async stop(): Promise<void> {
    this.resolveReady?.();
    this.resolveReady = null;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    for (const watcher of this.nativeWatchers.values()) watcher.close();
    this.nativeWatchers.clear();
    this.droppedRootCount = 0;
    this.registrations.clear();
  }

  isActive(): boolean {
    return this.watcher !== null || this.nativeWatchers.size > 0;
  }

  isRegistrationActive(root: string): boolean {
    if (this.watcher) return true;
    return [...this.nativeWatchers.keys()].some((watchedRoot) => isPathWithin(root, watchedRoot));
  }

  /** 供启动编排和集成测试等待初次索引完成，避免漏掉 ready 前的文件事件。 */
  waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  getWatchedDirectoryCount(): number {
    return this.watcher ? Object.keys(this.watcher.getWatched()).length : 0;
  }

  getWatchedRootCount(): number {
    if (this.watcher) {
      return compactWatchRoots(
        [...this.registrations.values()].map((registration) => registration.getResolvedRoot()),
      ).length;
    }
    return this.nativeWatchers.size;
  }

  getDroppedRootCount(): number {
    return this.droppedRootCount;
  }

  getMode(): FileWatcherBackendMode {
    if (this.usePolling) return 'chokidar-polling';
    return this.platform === 'darwin' ? 'darwin-native-recursive' : 'chokidar';
  }

  private startDarwinNativeWatchers(allRoots: string[]): void {
    const roots = allRoots.slice(0, MAX_NATIVE_RECURSIVE_WATCH_ROOTS);
    this.droppedRootCount = allRoots.length - roots.length;

    for (const root of roots) {
      try {
        const watcher = fs.watch(
          root,
          { recursive: true, persistent: true },
          (eventType, filename) => {
            if (filename == null || filename.toString().length === 0) {
              for (const registration of this.registrations.values()) {
                registration.handleSharedUnknownFsEvent(root);
              }
              return;
            }
            const absPath = path.resolve(root, filename.toString());
            for (const registration of this.registrations.values()) {
              registration.handleSharedNativeFsEvent(eventType, absPath);
            }
          },
        );
        watcher.on('error', (err) => {
          watcher.close();
          this.nativeWatchers.delete(root);
          console.warn(
            `[FileWatcher] macOS native recursive watcher error root=${root}: ` +
              `${err instanceof Error ? err.message : String(err)}; 依赖定时 sync 兜底`,
          );
        });
        this.nativeWatchers.set(root, watcher);
      } catch (err) {
        console.warn(
          `[FileWatcher] macOS native recursive watcher start failed root=${root}: ` +
            `${err instanceof Error ? err.message : String(err)}; 依赖定时 sync 兜底`,
        );
      }
    }

    console.log(
      `[FileWatcher] shared backend ready mode=darwin-native-recursive` +
        ` mappings=${this.registrations.size} roots=${this.nativeWatchers.size}` +
        `${this.droppedRootCount > 0 ? ` droppedRoots=${this.droppedRootCount}` : ''}`,
    );
    if (this.droppedRootCount > 0) {
      console.error(
        `[FileWatcher] watcher root 数量超过安全上限 ${MAX_NATIVE_RECURSIVE_WATCH_ROOTS}，` +
          `${this.droppedRootCount} 个 root 不启用实时监听，将由定时同步兜底`,
      );
    }
  }
}

/**
 * mapping 级 chokidar 封装：debounce 合并变更，sync 期间 pause，pull 写入 echo 过滤。
 * 硬排除 `.openclaw-sync-map.json`（方案一索引 consume 写入，避免误触发 push）。
 */
export class FileWatcher {
  private readonly opts: FileWatcherOptions;
  private readonly ignoreSet = new Set<string>();
  private watcher: FSWatcher | null = null;
  private pendingPaths = new Set<string>();
  private pendingPathOverflowCount = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private ignoreTailTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private started = false;

  constructor(
    opts: FileWatcherOptions,
    private readonly sharedBackend?: SharedFileWatcherBackend,
  ) {
    this.opts = opts;
  }

  getMappingId(): string {
    return this.opts.mappingId;
  }

  getResolvedRoot(): string {
    return path.resolve(this.opts.localRoot);
  }

  start(): void {
    if (this.started) return;

    const { localRoot, scope, usePolling, mappingId } = this.opts;
    const root = path.resolve(localRoot);

    if (!fs.existsSync(root)) {
      console.warn(`[FileWatcher][${mappingId}] localRoot 不存在，跳过监听: ${root}`);
      return;
    }

    this.started = true;

    if (this.sharedBackend) {
      this.sharedBackend.register(this);
      return;
    }

    this.watcher = chokidar.watch(root, {
      ignored: (absPath, stats) => this.shouldIgnoreWatchTarget(absPath, root, scope, stats),
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: WATCH_AWAIT_WRITE_STABILITY_MS,
        pollInterval: WATCH_AWAIT_WRITE_POLL_MS,
      },
      usePolling,
      depth: undefined,
    });

    this.watcher.on('all', (event, absPath) => {
      this.onFsEvent(event, absPath, root);
    });

    this.watcher.on('ready', () => {
      console.log(`[FileWatcher][${mappingId}] ready root=${root} polling=${usePolling}`);
    });

    this.watcher.on('error', (err) => {
      console.warn(
        `[FileWatcher][${mappingId}] error: ${err instanceof Error ? err.message : String(err)}; 依赖定时 sync 兜底`,
      );
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.clearDebounce();
    if (this.ignoreTailTimer) {
      clearTimeout(this.ignoreTailTimer);
      this.ignoreTailTimer = null;
    }
    this.ignoreSet.clear();
    this.pendingPaths.clear();
    this.pendingPathOverflowCount = 0;
    if (this.sharedBackend) {
      this.sharedBackend.unregister(this.opts.mappingId);
      return;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** sync 开始前暂停，丢弃期间所有 FS 事件 */
  pause(): void {
    this.paused = true;
    this.clearDebounce();
  }

  /**
   * sync 结束后恢复；将 pull 写入路径加入 ignoreSet 一段时间，防止 resume 后 echo push。
   */
  resumeAfterSync(pullWrittenPaths?: Iterable<string>): void {
    this.paused = false;
    if (pullWrittenPaths) {
      this.addIgnore(pullWrittenPaths);
    }
    if (this.ignoreSet.size > 0) {
      if (this.ignoreTailTimer) clearTimeout(this.ignoreTailTimer);
      const tailMs = this.opts.debounceMs + WATCH_AWAIT_WRITE_STABILITY_MS + WATCH_PULL_IGNORE_TAIL_MS;
      this.ignoreTailTimer = setTimeout(() => {
        this.ignoreSet.clear();
        this.ignoreTailTimer = null;
      }, tailMs);
    }
  }

  addIgnore(paths: Iterable<string>): void {
    for (const p of paths) {
      const key = canonicalizeRelativeSyncPath(normalizeSeparator(p));
      if (key) this.ignoreSet.add(key);
    }
    // 方案一索引：始终忽略（consume 写入；点文件通常已被 chokidar ignored 规则排除）
    this.ignoreSet.add(FILE_INDEX_NAME);
  }

  clearIgnore(): void {
    this.ignoreSet.clear();
    if (this.ignoreTailTimer) {
      clearTimeout(this.ignoreTailTimer);
      this.ignoreTailTimer = null;
    }
  }

  isActive(): boolean {
    return this.started &&
      (this.sharedBackend?.isRegistrationActive(this.getResolvedRoot()) ?? this.watcher !== null);
  }

  handleSharedFsEvent(event: string, absPath: string): void {
    if (!this.started) return;
    this.onFsEvent(event, absPath, this.getResolvedRoot());
  }

  handleSharedNativeFsEvent(event: string, absPath: string): void {
    if (!this.started) return;
    let kind: 'file' | 'directory' | 'unknown' = 'unknown';
    try {
      kind = fs.statSync(absPath).isDirectory() ? 'directory' : 'file';
    } catch {
      // rename 同时表示新增/删除；删除后无法 stat，按 unknown 同时检查文件和目录 scope。
    }
    this.onFsEvent(event, absPath, this.getResolvedRoot(), kind);
  }

  handleSharedUnknownFsEvent(watchedRoot: string): void {
    if (!this.started || this.paused) return;
    if (!isPathWithin(this.getResolvedRoot(), watchedRoot)) return;
    this.recordPendingPath('[unknown-native-event]');
    this.scheduleDebounce();
  }

  /** backend 的 ignored 回调：不属于本 mapping 时视为 ignore；属于时应用 mapping scope。 */
  shouldIgnoreSharedTarget(absPath: string, stats?: fs.Stats): boolean {
    if (!this.started) return true;
    return this.shouldIgnoreWatchTarget(absPath, this.getResolvedRoot(), this.opts.scope, stats);
  }

  private onFsEvent(
    event: string,
    absPath: string,
    root: string,
    kindOverride?: 'file' | 'directory' | 'unknown',
  ): void {
    if (this.paused) return;
    if (event === 'ready') return;

    const rel = this.toRelativePath(absPath, root);
    if (!rel) return;
    if (rel === FILE_INDEX_NAME) return;
    if (this.ignoreSet.has(rel)) return;

    const isDirEvent = event === 'addDir' || event === 'unlinkDir';
    const kind = kindOverride ?? (isDirEvent ? 'directory' : 'file');
    if (
      kind === 'unknown'
        ? !isInSyncScope(rel, this.opts.scope, 'file') &&
          !isInSyncScope(rel, this.opts.scope, 'directory')
        : !isInSyncScope(rel, this.opts.scope, kind)
    ) return;

    this.recordPendingPath(rel);
    this.scheduleDebounce();
  }

  private recordPendingPath(relativePath: string): void {
    if (this.pendingPaths.has(relativePath)) return;
    if (this.pendingPaths.size < MAX_PENDING_WATCH_PATHS) {
      this.pendingPaths.add(relativePath);
      return;
    }
    this.pendingPathOverflowCount++;
    if (this.pendingPathOverflowCount === 1) {
      console.warn(
        `[FileWatcher][${this.opts.mappingId}] debounce 路径超过 ${MAX_PENDING_WATCH_PATHS}，` +
          `后续仅累计数量，不再保留路径字符串`,
      );
    }
  }

  private scheduleDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.paused || this.pendingPaths.size === 0) return;
      const count = this.pendingPaths.size + this.pendingPathOverflowCount;
      this.pendingPaths.clear();
      this.pendingPathOverflowCount = 0;
      this.opts.onBatchReady(count);
    }, this.opts.debounceMs);
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingPaths.clear();
    this.pendingPathOverflowCount = 0;
  }

  private toRelativePath(absPath: string, root: string): string | null {
    const rel = path.relative(root, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return canonicalizeRelativeSyncPath(normalizeSeparator(rel));
  }

  /** 与 SyncEngine.matchesSync 一致：仅纳入同步范围的文件路径 */
  private matchesSyncScope(rel: string): boolean {
    const { scope } = this.opts;
    return isInSyncScope(rel, scope, 'file');
  }

  /**
   * chokidar ignored：索引文件、可选点路径规则、exclude 目录。
   * 勿 ignore 同步根（rel===''），否则 Windows 上可能收不到任何子路径事件。
   */
  private shouldIgnoreWatchTarget(
    absPath: string,
    root: string,
    scope: SyncScopeOptions,
    stats?: fs.Stats,
  ): boolean {
    const rel = path.relative(root, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
    if (rel === '') return false;

    const relNorm = normalizeSeparator(rel);
    if (relNorm === FILE_INDEX_NAME) return true;

    const base = path.basename(absPath);
    if (shouldSkipDotEntryName(base, scope.syncDotFiles)) return true;

    let isDirectory = stats?.isDirectory();
    if (isDirectory === undefined) {
      try {
        isDirectory = fs.statSync(absPath).isDirectory();
      } catch {
        return false;
      }
    }

    const kind = isDirectory ? 'directory' : 'file';
    return !isInSyncScope(relNorm, scope, kind);
  }
}

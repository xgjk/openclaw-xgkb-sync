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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileWatcher = exports.SharedFileWatcherBackend = void 0;
exports.compactWatchRoots = compactWatchRoots;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const chokidar_1 = __importDefault(require("chokidar"));
const constants_1 = require("./constants");
const pathSanitize_1 = require("./pathSanitize");
const pathSyncScope_1 = require("./pathSyncScope");
function isPathWithin(candidate, ancestor) {
    const rel = path.relative(path.resolve(ancestor), path.resolve(candidate));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
/** 去掉完全重复和被父目录覆盖的 root，避免为嵌套 mapping 重复建立递归 watcher。 */
function compactWatchRoots(roots) {
    const unique = [...new Set([...roots].map((root) => path.resolve(root)))].sort((a, b) => a.length - b.length || a.localeCompare(b));
    const compact = [];
    for (const root of unique) {
        if (!compact.some((parent) => isPathWithin(root, parent)))
            compact.push(root);
    }
    return compact;
}
/**
 * 多 mapping 共用的底层 chokidar 实例。
 *
 * chokidar 的每个 FSWatcher 都会维护一套完整的目录/文件索引；将多个 root 放进同一实例
 * 可自动去重父子/重叠目录，同时仍由 FileWatcher 保留 mapping 级 debounce、pause、ignore 语义。
 * polling 与非 polling 的底层机制不同，由 Scheduler 分成最多两个 backend。
 */
class SharedFileWatcherBackend {
    usePolling;
    platform;
    registrations = new Map();
    watcher = null;
    nativeWatchers = new Map();
    droppedRootCount = 0;
    readyPromise = Promise.resolve();
    resolveReady = null;
    constructor(usePolling, platform = process.platform) {
        this.usePolling = usePolling;
        this.platform = platform;
    }
    register(registration) {
        this.registrations.set(registration.getMappingId(), registration);
    }
    unregister(mappingId) {
        this.registrations.delete(mappingId);
    }
    start() {
        if (this.isActive() || this.registrations.size === 0)
            return;
        const roots = compactWatchRoots([...this.registrations.values()].map((registration) => registration.getResolvedRoot()));
        if (roots.length === 0)
            return;
        this.readyPromise = new Promise((resolve) => {
            this.resolveReady = resolve;
        });
        if (this.getMode() === 'darwin-native-recursive') {
            this.startDarwinNativeWatchers(roots);
            this.resolveReady?.();
            this.resolveReady = null;
            return;
        }
        this.watcher = chokidar_1.default.watch(roots, {
            ignored: (absPath, stats) => {
                for (const registration of this.registrations.values()) {
                    if (!registration.shouldIgnoreSharedTarget(absPath, stats))
                        return false;
                }
                return true;
            },
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: {
                stabilityThreshold: constants_1.WATCH_AWAIT_WRITE_STABILITY_MS,
                pollInterval: constants_1.WATCH_AWAIT_WRITE_POLL_MS,
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
            console.log(`[FileWatcher] shared backend ready mappings=${this.registrations.size}` +
                ` roots=${roots.length} polling=${this.usePolling}`);
        });
        this.watcher.on('error', (err) => {
            console.warn(`[FileWatcher] shared backend error polling=${this.usePolling}: ` +
                `${err instanceof Error ? err.message : String(err)}; 依赖定时 sync 兜底`);
        });
    }
    async stop() {
        this.resolveReady?.();
        this.resolveReady = null;
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
        }
        for (const watcher of this.nativeWatchers.values())
            watcher.close();
        this.nativeWatchers.clear();
        this.droppedRootCount = 0;
        this.registrations.clear();
    }
    isActive() {
        return this.watcher !== null || this.nativeWatchers.size > 0;
    }
    isRegistrationActive(root) {
        if (this.watcher)
            return true;
        return [...this.nativeWatchers.keys()].some((watchedRoot) => isPathWithin(root, watchedRoot));
    }
    /** 供启动编排和集成测试等待初次索引完成，避免漏掉 ready 前的文件事件。 */
    waitUntilReady() {
        return this.readyPromise;
    }
    getWatchedDirectoryCount() {
        return this.watcher ? Object.keys(this.watcher.getWatched()).length : 0;
    }
    getWatchedRootCount() {
        if (this.watcher) {
            return compactWatchRoots([...this.registrations.values()].map((registration) => registration.getResolvedRoot())).length;
        }
        return this.nativeWatchers.size;
    }
    getDroppedRootCount() {
        return this.droppedRootCount;
    }
    getMode() {
        if (this.usePolling)
            return 'chokidar-polling';
        return this.platform === 'darwin' ? 'darwin-native-recursive' : 'chokidar';
    }
    startDarwinNativeWatchers(allRoots) {
        const roots = allRoots.slice(0, constants_1.MAX_NATIVE_RECURSIVE_WATCH_ROOTS);
        this.droppedRootCount = allRoots.length - roots.length;
        for (const root of roots) {
            try {
                const watcher = fs.watch(root, { recursive: true, persistent: true }, (eventType, filename) => {
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
                });
                watcher.on('error', (err) => {
                    watcher.close();
                    this.nativeWatchers.delete(root);
                    console.warn(`[FileWatcher] macOS native recursive watcher error root=${root}: ` +
                        `${err instanceof Error ? err.message : String(err)}; 依赖定时 sync 兜底`);
                });
                this.nativeWatchers.set(root, watcher);
            }
            catch (err) {
                console.warn(`[FileWatcher] macOS native recursive watcher start failed root=${root}: ` +
                    `${err instanceof Error ? err.message : String(err)}; 依赖定时 sync 兜底`);
            }
        }
        console.log(`[FileWatcher] shared backend ready mode=darwin-native-recursive` +
            ` mappings=${this.registrations.size} roots=${this.nativeWatchers.size}` +
            `${this.droppedRootCount > 0 ? ` droppedRoots=${this.droppedRootCount}` : ''}`);
        if (this.droppedRootCount > 0) {
            console.error(`[FileWatcher] watcher root 数量超过安全上限 ${constants_1.MAX_NATIVE_RECURSIVE_WATCH_ROOTS}，` +
                `${this.droppedRootCount} 个 root 不启用实时监听，将由定时同步兜底`);
        }
    }
}
exports.SharedFileWatcherBackend = SharedFileWatcherBackend;
/**
 * mapping 级 chokidar 封装：debounce 合并变更，sync 期间 pause，pull 写入 echo 过滤。
 * 硬排除 `.openclaw-sync-map.json`（方案一索引 consume 写入，避免误触发 push）。
 */
class FileWatcher {
    sharedBackend;
    opts;
    ignoreSet = new Set();
    watcher = null;
    pendingPaths = new Set();
    pendingPathOverflowCount = 0;
    debounceTimer = null;
    ignoreTailTimer = null;
    paused = false;
    started = false;
    constructor(opts, sharedBackend) {
        this.sharedBackend = sharedBackend;
        this.opts = opts;
    }
    getMappingId() {
        return this.opts.mappingId;
    }
    getResolvedRoot() {
        return path.resolve(this.opts.localRoot);
    }
    start() {
        if (this.started)
            return;
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
        this.watcher = chokidar_1.default.watch(root, {
            ignored: (absPath, stats) => this.shouldIgnoreWatchTarget(absPath, root, scope, stats),
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: {
                stabilityThreshold: constants_1.WATCH_AWAIT_WRITE_STABILITY_MS,
                pollInterval: constants_1.WATCH_AWAIT_WRITE_POLL_MS,
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
            console.warn(`[FileWatcher][${mappingId}] error: ${err instanceof Error ? err.message : String(err)}; 依赖定时 sync 兜底`);
        });
    }
    async stop() {
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
    pause() {
        this.paused = true;
        this.clearDebounce();
    }
    /**
     * sync 结束后恢复；将 pull 写入路径加入 ignoreSet 一段时间，防止 resume 后 echo push。
     */
    resumeAfterSync(pullWrittenPaths) {
        this.paused = false;
        if (pullWrittenPaths) {
            this.addIgnore(pullWrittenPaths);
        }
        if (this.ignoreSet.size > 0) {
            if (this.ignoreTailTimer)
                clearTimeout(this.ignoreTailTimer);
            const tailMs = this.opts.debounceMs + constants_1.WATCH_AWAIT_WRITE_STABILITY_MS + constants_1.WATCH_PULL_IGNORE_TAIL_MS;
            this.ignoreTailTimer = setTimeout(() => {
                this.ignoreSet.clear();
                this.ignoreTailTimer = null;
            }, tailMs);
        }
    }
    addIgnore(paths) {
        for (const p of paths) {
            const key = (0, pathSanitize_1.canonicalizeRelativeSyncPath)((0, pathSanitize_1.normalizeSeparator)(p));
            if (key)
                this.ignoreSet.add(key);
        }
        // 方案一索引：始终忽略（consume 写入；点文件通常已被 chokidar ignored 规则排除）
        this.ignoreSet.add(constants_1.FILE_INDEX_NAME);
    }
    clearIgnore() {
        this.ignoreSet.clear();
        if (this.ignoreTailTimer) {
            clearTimeout(this.ignoreTailTimer);
            this.ignoreTailTimer = null;
        }
    }
    isActive() {
        return this.started &&
            (this.sharedBackend?.isRegistrationActive(this.getResolvedRoot()) ?? this.watcher !== null);
    }
    handleSharedFsEvent(event, absPath) {
        if (!this.started)
            return;
        this.onFsEvent(event, absPath, this.getResolvedRoot());
    }
    handleSharedNativeFsEvent(event, absPath) {
        if (!this.started)
            return;
        let kind = 'unknown';
        try {
            kind = fs.statSync(absPath).isDirectory() ? 'directory' : 'file';
        }
        catch {
            // rename 同时表示新增/删除；删除后无法 stat，按 unknown 同时检查文件和目录 scope。
        }
        this.onFsEvent(event, absPath, this.getResolvedRoot(), kind);
    }
    handleSharedUnknownFsEvent(watchedRoot) {
        if (!this.started || this.paused)
            return;
        if (!isPathWithin(this.getResolvedRoot(), watchedRoot))
            return;
        this.recordPendingPath('[unknown-native-event]');
        this.scheduleDebounce();
    }
    /** backend 的 ignored 回调：不属于本 mapping 时视为 ignore；属于时应用 mapping scope。 */
    shouldIgnoreSharedTarget(absPath, stats) {
        if (!this.started)
            return true;
        return this.shouldIgnoreWatchTarget(absPath, this.getResolvedRoot(), this.opts.scope, stats);
    }
    onFsEvent(event, absPath, root, kindOverride) {
        if (this.paused)
            return;
        if (event === 'ready')
            return;
        const rel = this.toRelativePath(absPath, root);
        if (!rel)
            return;
        if (rel === constants_1.FILE_INDEX_NAME)
            return;
        if (this.ignoreSet.has(rel))
            return;
        const isDirEvent = event === 'addDir' || event === 'unlinkDir';
        const kind = kindOverride ?? (isDirEvent ? 'directory' : 'file');
        if (kind === 'unknown'
            ? !(0, pathSyncScope_1.isInSyncScope)(rel, this.opts.scope, 'file') &&
                !(0, pathSyncScope_1.isInSyncScope)(rel, this.opts.scope, 'directory')
            : !(0, pathSyncScope_1.isInSyncScope)(rel, this.opts.scope, kind))
            return;
        this.recordPendingPath(rel);
        this.scheduleDebounce();
    }
    recordPendingPath(relativePath) {
        if (this.pendingPaths.has(relativePath))
            return;
        if (this.pendingPaths.size < constants_1.MAX_PENDING_WATCH_PATHS) {
            this.pendingPaths.add(relativePath);
            return;
        }
        this.pendingPathOverflowCount++;
        if (this.pendingPathOverflowCount === 1) {
            console.warn(`[FileWatcher][${this.opts.mappingId}] debounce 路径超过 ${constants_1.MAX_PENDING_WATCH_PATHS}，` +
                `后续仅累计数量，不再保留路径字符串`);
        }
    }
    scheduleDebounce() {
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            if (this.paused || this.pendingPaths.size === 0)
                return;
            const count = this.pendingPaths.size + this.pendingPathOverflowCount;
            this.pendingPaths.clear();
            this.pendingPathOverflowCount = 0;
            this.opts.onBatchReady(count);
        }, this.opts.debounceMs);
    }
    clearDebounce() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.pendingPaths.clear();
        this.pendingPathOverflowCount = 0;
    }
    toRelativePath(absPath, root) {
        const rel = path.relative(root, absPath);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
            return null;
        return (0, pathSanitize_1.canonicalizeRelativeSyncPath)((0, pathSanitize_1.normalizeSeparator)(rel));
    }
    /** 与 SyncEngine.matchesSync 一致：仅纳入同步范围的文件路径 */
    matchesSyncScope(rel) {
        const { scope } = this.opts;
        return (0, pathSyncScope_1.isInSyncScope)(rel, scope, 'file');
    }
    /**
     * chokidar ignored：索引文件、可选点路径规则、exclude 目录。
     * 勿 ignore 同步根（rel===''），否则 Windows 上可能收不到任何子路径事件。
     */
    shouldIgnoreWatchTarget(absPath, root, scope, stats) {
        const rel = path.relative(root, absPath);
        if (rel.startsWith('..') || path.isAbsolute(rel))
            return true;
        if (rel === '')
            return false;
        const relNorm = (0, pathSanitize_1.normalizeSeparator)(rel);
        if (relNorm === constants_1.FILE_INDEX_NAME)
            return true;
        const base = path.basename(absPath);
        if ((0, pathSyncScope_1.shouldSkipDotEntryName)(base, scope.syncDotFiles))
            return true;
        let isDirectory = stats?.isDirectory();
        if (isDirectory === undefined) {
            try {
                isDirectory = fs.statSync(absPath).isDirectory();
            }
            catch {
                return false;
            }
        }
        const kind = isDirectory ? 'directory' : 'file';
        return !(0, pathSyncScope_1.isInSyncScope)(relNorm, scope, kind);
    }
}
exports.FileWatcher = FileWatcher;
//# sourceMappingURL=fileWatcher.js.map
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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const chokidar_1 = __importDefault(require("chokidar"));
const constants_1 = require("./constants");
const pathSanitize_1 = require("./pathSanitize");
const pathSyncScope_1 = require("./pathSyncScope");
/**
 * 多 mapping 共用的底层 chokidar 实例。
 *
 * chokidar 的每个 FSWatcher 都会维护一套完整的目录/文件索引；将多个 root 放进同一实例
 * 可自动去重父子/重叠目录，同时仍由 FileWatcher 保留 mapping 级 debounce、pause、ignore 语义。
 * polling 与非 polling 的底层机制不同，由 Scheduler 分成最多两个 backend。
 */
class SharedFileWatcherBackend {
    usePolling;
    registrations = new Map();
    watcher = null;
    readyPromise = Promise.resolve();
    resolveReady = null;
    constructor(usePolling) {
        this.usePolling = usePolling;
    }
    register(registration) {
        this.registrations.set(registration.getMappingId(), registration);
    }
    unregister(mappingId) {
        this.registrations.delete(mappingId);
    }
    start() {
        if (this.watcher || this.registrations.size === 0)
            return;
        const roots = [
            ...new Set([...this.registrations.values()].map((r) => r.getResolvedRoot())),
        ];
        if (roots.length === 0)
            return;
        this.readyPromise = new Promise((resolve) => {
            this.resolveReady = resolve;
        });
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
        this.registrations.clear();
    }
    isActive() {
        return this.watcher !== null;
    }
    /** 供启动编排和集成测试等待初次索引完成，避免漏掉 ready 前的文件事件。 */
    waitUntilReady() {
        return this.readyPromise;
    }
    getWatchedDirectoryCount() {
        return this.watcher ? Object.keys(this.watcher.getWatched()).length : 0;
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
        return this.started && (this.sharedBackend?.isActive() ?? this.watcher !== null);
    }
    handleSharedFsEvent(event, absPath) {
        if (!this.started)
            return;
        this.onFsEvent(event, absPath, this.getResolvedRoot());
    }
    /** backend 的 ignored 回调：不属于本 mapping 时视为 ignore；属于时应用 mapping scope。 */
    shouldIgnoreSharedTarget(absPath, stats) {
        if (!this.started)
            return true;
        return this.shouldIgnoreWatchTarget(absPath, this.getResolvedRoot(), this.opts.scope, stats);
    }
    onFsEvent(event, absPath, root) {
        if (this.paused)
            return;
        if (event === 'ready')
            return;
        const rel = this.toRelativePath(absPath, root);
        if (!rel)
            return;
        if (this.ignoreSet.has(rel))
            return;
        const isDirEvent = event === 'addDir' || event === 'unlinkDir';
        const kind = isDirEvent ? 'directory' : 'file';
        if (!(0, pathSyncScope_1.isInSyncScope)(rel, this.opts.scope, kind))
            return;
        this.pendingPaths.add(rel);
        this.scheduleDebounce();
    }
    scheduleDebounce() {
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            if (this.paused || this.pendingPaths.size === 0)
                return;
            const count = this.pendingPaths.size;
            this.pendingPaths.clear();
            this.opts.onBatchReady(count);
        }, this.opts.debounceMs);
    }
    clearDebounce() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.pendingPaths.clear();
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
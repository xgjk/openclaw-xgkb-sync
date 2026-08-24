import { KbApiClient } from './kbApi';
import { FileWatcher, SharedFileWatcherBackend } from './fileWatcher';
import { LocalFsAdapter } from './localFs';
import { RateLimiter } from './rateLimiter';
import { RemoteFsAdapter, RemoteFsInitResult } from './remoteFs';
import { SyncEngine } from './syncEngine';
import { SyncStateDb } from './syncStateDb';
import { isMappingEffectiveEnabled } from './config';
import { SyncConfig, SyncMapping, MappingSyncRunResult, SyncStats, SyncTriggerReason } from './types';
import {
  DEFAULT_DB_PATH,
  DEFAULT_FULL_RECONCILE_INTERVAL_SEC,
  DEFAULT_MASS_SYNC_PROTECTION_ENABLED,
  DEFAULT_MAX_CONCURRENT_MAPPINGS,
  DEFAULT_MAX_DOWNLOAD_FILES_PER_SYNC,
  DEFAULT_MAX_REQUESTS_PER_MINUTE,
  DEFAULT_MAX_UPLOAD_FILES_PER_SYNC,
  DEFAULT_RATE_LIMIT_BURST,
  DOWNLOAD_CONCURRENCY,
  MAX_CONCURRENT_MAPPINGS_LIMIT,
  PERMANENT_ERROR_CIRCUIT_BASE_MS,
  PERMANENT_ERROR_CIRCUIT_MAX_MS,
  RATE_LIMIT_COOLDOWN_MS,
  STARTUP_JITTER_MAX_MS,
  STOP_DRAIN_TIMEOUT_MS,
  UPLOAD_CONCURRENCY,
} from './constants';
import {
  formatSyncTriggerReason,
  resolvePushDebounceMs,
  resolveWatchEnabled,
  resolveWatchUsePolling,
} from './watchHelpers';
import { ensureMappingLocalRoot } from './ensureLocalRoot';
import { inspectLocalRoot, hasMappingSyncHistory } from './localRootGuard';
import { resolveSyncScopeOptions } from './pathSyncScope';
import {
  classifyPermanentSyncFailure,
  permanentCircuitDelayMs,
} from './syncErrorPolicy';
import { isMassSyncProtectionError } from './syncSafety';

let schedulerInstanceSeq = 0;

interface MappingRunState {
  isSyncing: boolean;
  /** 当前正在同步时收到新触发，完成后立刻再执行一轮 */
  pendingSync: boolean;
  /** 挂起同步的触发来源（watch 优先于 timer） */
  pendingReason?: SyncTriggerReason;
  lastTriggerReason?: SyncTriggerReason;
  /** 最近一次由 watch 触发的本地时间戳（毫秒） */
  lastWatchTriggerAt?: number;
}

interface DoSyncResult {
  pullTouchPaths: string[];
  stats?: SyncStats;
  errorMsg?: string;
  /** localRoot 从有到无：已挂起，待写 config 禁用 mapping */
  shouldDisableMapping?: boolean;
  disableCause?: 'missing-local-root' | 'mass-sync-protection';
  /** 明确的鉴权/权限/参数类远端错误，触发 mapping 级熔断。 */
  permanentError?: string;
}

interface MappingCircuitBreaker {
  level: number;
  trippedAt: number;
  until: number;
  reason: string;
  lastSkipLogAt?: number;
}

export interface SyncSchedulerOptions {
  onMappingSyncFinished?: (result: MappingSyncRunResult) => void;
  /** 安全保护触发后写 config 禁用 mapping，并触发热重载。 */
  onMappingAutoDisable?: (
    mappingId: string,
    detail: string,
    cause: 'missing-local-root' | 'mass-sync-protection',
  ) => Promise<void>;
  /** 仅用于测试或特殊部署；生产默认 5 分钟。 */
  stopDrainTimeoutMs?: number;
}

export function resolveMaxConcurrentMappings(config: SyncConfig): number {
  const enabledMappings = config.mappings.filter((m) =>
    isMappingEffectiveEnabled(m, config.mappings),
  );
  if (enabledMappings.length === 0) return 0;

  if (config.maxConcurrentMappingsMode === 'manual') {
    return Math.min(
      MAX_CONCURRENT_MAPPINGS_LIMIT,
      Math.max(1, Math.floor(config.maxConcurrentMappings ?? DEFAULT_MAX_CONCURRENT_MAPPINGS)),
    );
  }

  const appKeySet = new Set(
    enabledMappings.map((m) => (m.appKey ?? config.appKey ?? '').trim()).filter(Boolean),
  );
  const allUseIndependentKeys = appKeySet.size >= enabledMappings.length;

  if (enabledMappings.length <= 2) return enabledMappings.length;
  if (allUseIndependentKeys) return Math.min(5, enabledMappings.length);
  return Math.min(3, enabledMappings.length);
}

/**
 * 多 Mapping 同步调度器
 * - 同一 mappingId 严格串行（防重入）
 * - 不同 mappingId 可受控并发（maxConcurrentMappings）
 * - 定时触发 + 手动触发双路径
 */
export class SyncScheduler {
  /** 每个 scheduler 实例唯一 ID，延迟任务携带此 ID，防止旧实例回调在 stop 后仍执行 */
  private readonly instanceId = ++schedulerInstanceSeq;
  private readonly config: SyncConfig;
  private readonly db: SyncStateDb;
  /** 按 appKey 分组的限速器，每个 appKey 独享自己的令牌桶 */
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly runStates = new Map<string, MappingRunState>();
  private readonly watchers = new Map<string, FileWatcher>();
  private readonly watcherBackends: SharedFileWatcherBackend[] = [];
  private timers: NodeJS.Timeout[] = [];
  /** triggerAll 错峰、启动抖动、pendingSync 等延迟任务 */
  private readonly pendingTimers = new Set<NodeJS.Timeout>();
  private activeSyncCount = 0;
  /** 全局同时进行中的 mapping 同步数（真·运行上限，保护事件循环与 /health） */
  private globalRunningSyncs = 0;
  private readonly maxGlobalRunningSyncs: number;
  private readonly syncDrainWaiters: Array<() => void> = [];
  private running = false;
  private dbClosed = false;
  private readonly onMappingSyncFinished?: (result: MappingSyncRunResult) => void;
  private readonly onMappingAutoDisable?: (
    mappingId: string,
    detail: string,
    cause: 'missing-local-root' | 'mass-sync-protection',
  ) => Promise<void>;
  private readonly stopDrainTimeoutMs: number;
  /** localRoot 缺失后即时挂起，阻止 timer/watch 继续触发（热重载前） */
  private readonly suspendedMappingIds = new Set<string>();
  private readonly autoDisableInFlight = new Set<string>();
  private readonly circuitBreakers = new Map<string, MappingCircuitBreaker>();

  constructor(config: SyncConfig, opts?: SyncSchedulerOptions) {
    this.config = config;
    this.onMappingSyncFinished = opts?.onMappingSyncFinished;
    this.onMappingAutoDisable = opts?.onMappingAutoDisable;
    this.stopDrainTimeoutMs = opts?.stopDrainTimeoutMs ?? STOP_DRAIN_TIMEOUT_MS;
    this.maxGlobalRunningSyncs = resolveMaxConcurrentMappings(config);
    const dbPath = config.stateDbPath ?? DEFAULT_DB_PATH;
    this.db = new SyncStateDb(dbPath);
    console.log(
      `[Scheduler] 实例#${this.instanceId} 状态库: ${dbPath}，全局最多 ${this.maxGlobalRunningSyncs} 路并行同步`,
    );
  }

  /**
   * 按 appKey 获取或创建对应的限速器。
   * 同一 appKey 的所有请求共享一个令牌桶，不同 appKey 互不干扰。
   */
  private getLimiter(appKey: string): RateLimiter {
    if (!this.limiters.has(appKey)) {
      const rpm = this.config.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE;
      const burst = this.config.rateLimitBurst ?? DEFAULT_RATE_LIMIT_BURST;
      const cooldownMs = (this.config.rateLimitCooldownSec ?? RATE_LIMIT_COOLDOWN_MS / 1000) * 1000;
      const limiter = new RateLimiter({
        requestsPerMinute: rpm,
        burst,
        cooldownMs,
        label: `KbApi(${appKey.slice(0, 8)}…)`,
      });
      this.limiters.set(appKey, limiter);
      console.log(
        `[Scheduler] 新建限速器 appKey=${appKey.slice(0, 8)}… ${rpm} req/min 突发=${burst} 冷却=${cooldownMs / 1000}s`,
      );
    }
    return this.limiters.get(appKey)!;
  }

  /** 启动调度器：注册定时器，并立即触发一轮全量对账 */
  start(): void {
    if (this.running) return;
    this.running = true;

    const enabledMappings = this.config.mappings.filter((m) =>
      isMappingEffectiveEnabled(m, this.config.mappings),
    );
    console.log(
      `[Scheduler] 启动，映射规则: ${enabledMappings.length} 条，自动同步间隔: ${this.config.autoSyncIntervalSec}s`,
    );

    for (const mapping of enabledMappings) {
      this.runStates.set(mapping.mappingId, { isSyncing: false, pendingSync: false });
      const persisted = this.db.getMappingState(mapping.mappingId);
      if (
        persisted?.circuitBreakerLevel &&
        persisted.circuitBreakerUntil &&
        persisted.circuitBreakerReason
      ) {
        this.circuitBreakers.set(mapping.mappingId, {
          level: persisted.circuitBreakerLevel,
          trippedAt: 0,
          until: persisted.circuitBreakerUntil,
          reason: persisted.circuitBreakerReason,
        });
      }
    }

    this.startWatchers(enabledMappings);

    // 启动后加随机抖动再触发首次同步，分散多实例同时启动的请求突刺
    const jitterMaxMs =
      (this.config.startupJitterMaxSec ?? STARTUP_JITTER_MAX_MS / 1000) * 1000;
    const jitterMs = jitterMaxMs > 0 ? Math.floor(Math.random() * jitterMaxMs) : 0;
    if (jitterMs > 500) {
      console.log(
        `[Scheduler] 启动抖动 ${Math.round(jitterMs / 1000)}s，首次同步约在 ${new Date(Date.now() + jitterMs).toLocaleTimeString('zh-CN')} 开始`,
      );
      this.scheduleDelayed(() => this.triggerAll('启动后初始同步', 'startup'), jitterMs);
    } else {
      this.triggerAll('启动后初始同步', 'startup');
    }

    this.registerIntervalTimer();
  }

  private registerIntervalTimer(): void {
    const intervalSec = this.config.autoSyncIntervalSec;
    if (intervalSec > 0) {
      const timer = setInterval(() => {
        this.triggerAll('定时同步', 'timer');
      }, intervalSec * 1000);
      this.timers.push(timer);
      console.log(`[Scheduler] 定时器已注册，间隔 ${intervalSec}s`);
    }
  }

  /**
   * 停止调度器：取消未执行的延迟任务，等待进行中的 sync 结束，再关闭 DB。
   * @returns true 表示已安全停止并关闭 DB；false 表示仍有同步未完成（未关 DB，避免 Database already closed）
   */
  async stop(opts?: { resumeOnTimeout?: boolean }): Promise<boolean> {
    if (this.dbClosed) return true;

    console.log(`[Scheduler] 实例#${this.instanceId} 正在停止...`);
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.clearPendingTimers();

    if (this.activeSyncCount > 0) {
      console.log(
        `[Scheduler] 等待 ${this.activeSyncCount} 个进行中的同步结束（最多 ${this.stopDrainTimeoutMs / 1000}s）...`,
      );
      try {
        await this.waitForActiveSyncs(this.stopDrainTimeoutMs);
      } catch (e) {
        console.warn(
          '[Scheduler] 等待同步结束超时:',
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    if (this.activeSyncCount > 0 && opts?.resumeOnTimeout) {
      // reload 失败必须回滚为“旧 scheduler 继续服务”；watcher 此时尚未停止。
      this.running = true;
      this.registerIntervalTimer();
      console.error(
        `[Scheduler] 实例#${this.instanceId} 停止超时，已恢复旧调度器的定时与 watcher 调度，` +
          `避免热重载失败后永久停止同步`,
      );
      this.triggerAll('热重载超时后恢复旧调度器', 'timer');
      return false;
    }

    await this.stopWatchers();
    this.limiters.clear();

    if (this.activeSyncCount > 0) {
      console.error(
        `[Scheduler] 实例#${this.instanceId} 仍有 ${this.activeSyncCount} 个同步未完成，保留数据库连接（避免 Database already closed）`,
      );
      return false;
    }

    if (!this.dbClosed) {
      this.db.close();
      this.dbClosed = true;
    }
    console.log(`[Scheduler] 实例#${this.instanceId} 已停止`);
    return true;
  }

  private scheduleDelayed(fn: () => void, delayMs: number): void {
    const instanceId = this.instanceId;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (instanceId !== this.instanceId || !this.running || this.dbClosed) return;
      fn();
    }, delayMs);
    this.pendingTimers.add(timer);
  }

  private clearPendingTimers(): void {
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers.clear();
  }

  private waitForActiveSyncs(timeoutMs: number): Promise<void> {
    if (this.activeSyncCount <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.syncDrainWaiters.indexOf(onDrain);
        if (idx >= 0) this.syncDrainWaiters.splice(idx, 1);
        reject(new Error(`仍有 ${this.activeSyncCount} 个同步未在 ${timeoutMs}ms 内结束`));
      }, timeoutMs);
      const onDrain = () => {
        clearTimeout(timer);
        resolve();
      };
      this.syncDrainWaiters.push(onDrain);
    });
  }

  private notifySyncDrain(): void {
    if (this.activeSyncCount > 0) return;
    const waiters = this.syncDrainWaiters.splice(0);
    for (const w of waiters) w();
  }

  /** 全局并发空出后，唤醒一条 pending 的 mapping */
  private drainOnePendingSync(): void {
    if (!this.running || this.dbClosed) return;
    if (this.globalRunningSyncs >= this.maxGlobalRunningSyncs) return;

    for (const [mappingId, runState] of this.runStates) {
      if (!runState.pendingSync || runState.isSyncing) continue;
      const mapping = this.config.mappings.find(
        (m) => m.mappingId === mappingId && isMappingEffectiveEnabled(m, this.config.mappings),
      );
      if (!mapping) continue;
      runState.pendingSync = false;
      const reason = runState.pendingReason ?? 'manual';
      runState.pendingReason = undefined;
      this.scheduleMapping(mapping, reason);
      return;
    }
  }

  /** 供探针判断负载：全局并行同步数 / 上限 */
  getGlobalSyncPressure(): { running: number; max: number } {
    return { running: this.globalRunningSyncs, max: this.maxGlobalRunningSyncs };
  }

  getLifecycleStatus(): { running: boolean; dbClosed: boolean } {
    return { running: this.running, dbClosed: this.dbClosed };
  }

  getWatcherPressure(): {
    mappings: number;
    backends: number;
    watchedDirectories: number;
    watchedRoots: number;
    droppedRoots: number;
    modes: Record<string, number>;
  } {
    const modes: Record<string, number> = {};
    for (const backend of this.watcherBackends) {
      if (!backend.isActive()) continue;
      modes[backend.getMode()] = (modes[backend.getMode()] ?? 0) + 1;
    }
    return {
      mappings: [...this.watchers.values()].filter((watcher) => watcher.isActive()).length,
      backends: this.watcherBackends.filter((backend) => backend.isActive()).length,
      watchedDirectories: this.watcherBackends.reduce(
        (total, backend) => total + backend.getWatchedDirectoryCount(),
        0,
      ),
      watchedRoots: this.watcherBackends.reduce(
        (total, backend) => total + backend.getWatchedRootCount(),
        0,
      ),
      droppedRoots: this.watcherBackends.reduce(
        (total, backend) => total + backend.getDroppedRootCount(),
        0,
      ),
      modes,
    };
  }

  getCircuitBreakerPressure(): { open: number; total: number } {
    const now = Date.now();
    let open = 0;
    for (const breaker of this.circuitBreakers.values()) {
      if (breaker.until > now) open++;
    }
    return { open, total: this.circuitBreakers.size };
  }

  /** 无进行中的 mapping 同步（供自动升级等场景） */
  isSyncIdle(): boolean {
    return this.activeSyncCount === 0 && this.globalRunningSyncs === 0;
  }

  private startWatchers(mappings: SyncMapping[]): void {
    const backends = new Map<boolean, SharedFileWatcherBackend>();
    for (const mapping of mappings) {
      if (!resolveWatchEnabled(mapping, this.config)) continue;

      const ensured = ensureMappingLocalRoot(mapping.localRoot);
      if (!ensured.ok) {
        console.warn(`[FileWatcher][${mapping.mappingId}] ${ensured.error}`);
      }

      const scope = resolveSyncScopeOptions(mapping, this.config);
      const usePolling = resolveWatchUsePolling(mapping, this.config);
      let backend = backends.get(usePolling);
      if (!backend) {
        backend = new SharedFileWatcherBackend(usePolling);
        backends.set(usePolling, backend);
        this.watcherBackends.push(backend);
      }

      const watcher = new FileWatcher({
        mappingId: mapping.mappingId,
        localRoot: mapping.localRoot,
        scope,
        debounceMs: resolvePushDebounceMs(mapping, this.config),
        usePolling,
        onBatchReady: () => {
          this.scheduleMapping(mapping, 'watch');
        },
      }, backend);
      watcher.start();
      this.watchers.set(mapping.mappingId, watcher);
    }

    for (const backend of this.watcherBackends) backend.start();

    if (this.watchers.size > 0) {
      console.log(`[Scheduler] 文件监听已启动: ${this.watchers.size} 条 mapping`);
    }
  }

  private async stopWatchers(): Promise<void> {
    const stops = [...this.watchers.values()].map((w) => w.stop());
    await Promise.all(stops);
    this.watchers.clear();
    await Promise.all(this.watcherBackends.map((backend) => backend.stop()));
    this.watcherBackends.length = 0;
  }

  /** 手动触发指定 mapping 同步 */
  triggerMapping(mappingId: string): void {
    if (!this.running || this.dbClosed) {
      console.warn(`[Scheduler] 调度器已停止，忽略同步触发: ${mappingId}`);
      return;
    }
    const mapping = this.config.mappings.find(
      (m) => m.mappingId === mappingId && isMappingEffectiveEnabled(m, this.config.mappings),
    );
    if (!mapping) {
      console.warn(`[Scheduler] 未找到或未启用的 mapping: ${mappingId}`);
      return;
    }
    this.scheduleMapping(mapping, 'manual');
  }

  /** 触发所有已启用 mapping */
  private triggerAll(reason: string, trigger: SyncTriggerReason): void {
    if (!this.running || this.dbClosed) return;

    const enabledMappings = this.config.mappings.filter((m) =>
      isMappingEffectiveEnabled(m, this.config.mappings),
    );
    console.log(`[Scheduler] 触发全部同步（${reason}），共 ${enabledMappings.length} 条`);

    // 立即登记到有界的 per-mapping pending 状态；真正启动受 globalRunningSyncs 限制。
    // 不再为数百个 mapping 创建逐个 setTimeout，避免热重载时残留大量延迟任务。
    for (const mapping of enabledMappings) {
      this.scheduleMapping(mapping, trigger);
    }
  }

  private scheduleMapping(
    mapping: SyncMapping,
    reason: SyncTriggerReason = 'manual',
  ): void {
    if (!this.running || this.dbClosed) return;

    if (this.suspendedMappingIds.has(mapping.mappingId)) {
      console.log(
        `[Scheduler][${mapping.mappingId}] 已挂起（localRoot 缺失），跳过同步 (${formatSyncTriggerReason(reason)})`,
      );
      return;
    }

    if (reason !== 'manual' && this.shouldSkipForCircuit(mapping.mappingId)) return;

    let state = this.runStates.get(mapping.mappingId);
    if (!state) {
      state = { isSyncing: false, pendingSync: false };
      this.runStates.set(mapping.mappingId, state);
    }

    if (state.isSyncing) {
      const wasPending = state.pendingSync;
      state.pendingSync = true;
      if (reason === 'watch' || state.pendingReason !== 'watch') {
        state.pendingReason = reason;
      }
      if (!wasPending) {
        console.log(
          `[Scheduler][${mapping.mappingId}] 同步中收到新触发，已合并为下一轮 (${formatSyncTriggerReason(reason)})`,
        );
      }
      return;
    }

    if (this.globalRunningSyncs >= this.maxGlobalRunningSyncs) {
      const wasPending = state.pendingSync;
      state.pendingSync = true;
      if (reason === 'watch' || state.pendingReason !== 'watch') {
        state.pendingReason = reason;
      }
      if (!wasPending) {
        console.log(
          `[Scheduler][${mapping.mappingId}] 全局限流 ${this.globalRunningSyncs}/${this.maxGlobalRunningSyncs}，已排队 (${formatSyncTriggerReason(reason)})`,
        );
      }
      return;
    }

    state.lastTriggerReason = reason;
    if (reason === 'watch') {
      state.lastWatchTriggerAt = Date.now();
    }
    this.runMappingSync(mapping, state, reason).catch((e) => {
      console.error(`[Scheduler][${mapping.mappingId}] 意外异常:`, e);
    });
  }

  private async runMappingSync(
    mapping: SyncMapping,
    state: MappingRunState,
    reason: SyncTriggerReason,
  ): Promise<void> {
    if (!this.running || this.dbClosed) return;

    this.activeSyncCount++;
    this.globalRunningSyncs++;
    state.isSyncing = true;
    state.pendingSync = false;
    state.pendingReason = undefined;

    const watcher = this.watchers.get(mapping.mappingId);
    watcher?.pause();

    const startTime = Date.now();
    let syncResult: DoSyncResult = { pullTouchPaths: [] };
    let shouldDisableMapping = false;
    let disableCause: DoSyncResult['disableCause'];
    let circuitTripped = false;
    try {
      syncResult = await this.doSync(mapping, reason);
      shouldDisableMapping = syncResult.shouldDisableMapping === true;
      disableCause = syncResult.disableCause;
      if (syncResult.permanentError) {
        this.tripCircuit(mapping.mappingId, syncResult.permanentError);
        circuitTripped = true;
      } else if (syncResult.stats && syncResult.stats.failed === 0) {
        this.clearCircuit(mapping.mappingId);
      }
    } finally {
      if (!shouldDisableMapping) {
        watcher?.resumeAfterSync(syncResult.pullTouchPaths);
      }

      state.isSyncing = false;
      this.activeSyncCount--;
      this.globalRunningSyncs--;
      this.notifySyncDrain();
      this.drainOnePendingSync();

      const endTime = Date.now();
      const stats = syncResult.stats;
      let errorMsg = syncResult.errorMsg;
      if (!errorMsg && stats && stats.failed > 0) {
        errorMsg = stats.errors.slice(0, 3).join('; ');
      }
      console.log(
        `[Scheduler][${mapping.mappingId}] END status=${errorMsg ? 'failed' : 'ok'}` +
          ` durationMs=${endTime - startTime}` +
          ` upload=${stats?.uploaded ?? 0} download=${stats?.downloaded ?? 0}` +
          ` delete=${stats?.deleted ?? 0} rename=${stats?.renamed ?? 0} move=${stats?.moved ?? 0}` +
          ` skip=${stats?.skipped ?? 0} failed=${stats?.failed ?? 0}` +
          ` scan=${stats ? (stats.fullScan ? 'full' : 'incremental') : 'unknown'}` +
          ` watermark=${stats?.newSince ?? '-'}`,
      );
      this.onMappingSyncFinished?.({
        mappingId: mapping.mappingId,
        triggerReason: reason,
        startTime,
        endTime,
        uploaded: stats?.uploaded ?? 0,
        downloaded: stats?.downloaded ?? 0,
        deleted: stats?.deleted ?? 0,
        skipped: stats?.skipped ?? 0,
        failed: stats?.failed ?? 0,
        errorMsg,
      });

      // 若同步期间有新触发，再执行一轮（localRoot 缺失挂起时不再排队）
      if (
        this.running &&
        !this.dbClosed &&
        state.pendingSync &&
        !shouldDisableMapping &&
        !circuitTripped &&
        !this.suspendedMappingIds.has(mapping.mappingId)
      ) {
        const pendingReason = state.pendingReason ?? 'manual';
        state.pendingSync = false;
        state.pendingReason = undefined;
        this.scheduleDelayed(() => this.scheduleMapping(mapping, pendingReason), 0);
      } else if (state.pendingSync || shouldDisableMapping || circuitTripped) {
        state.pendingSync = false;
        state.pendingReason = undefined;
      }
    }

    if (shouldDisableMapping) {
      await this.disableMappingAfterSafetyStop(
        mapping.mappingId,
        syncResult.errorMsg ?? '安全保护触发',
        disableCause ?? 'missing-local-root',
      );
    }
  }

  /**
   * localRoot 从有到无：即时挂起（停 watch、清排队），随后写 config 禁用 mapping。
   */
  private suspendMapping(mappingId: string, reason: string): void {
    if (this.suspendedMappingIds.has(mappingId)) return;
    this.suspendedMappingIds.add(mappingId);

    const state = this.runStates.get(mappingId);
    if (state) {
      state.pendingSync = false;
      state.pendingReason = undefined;
    }

    const watcher = this.watchers.get(mappingId);
    if (watcher) {
      void watcher.stop();
      this.watchers.delete(mappingId);
    }

    console.warn(`[Scheduler][${mappingId}] 已挂起同步（${reason}）`);
  }

  private async disableMappingAfterSafetyStop(
    mappingId: string,
    detail: string,
    cause: 'missing-local-root' | 'mass-sync-protection',
  ): Promise<void> {
    if (!this.onMappingAutoDisable) {
      console.warn(
        `[Scheduler][${mappingId}] ${cause} 但未配置 onMappingAutoDisable，仅保持挂起`,
      );
      return;
    }
    if (this.autoDisableInFlight.has(mappingId)) return;
    this.autoDisableInFlight.add(mappingId);
    try {
      await this.onMappingAutoDisable(mappingId, detail, cause);
    } catch (e) {
      console.error(
        `[Scheduler][${mappingId}] 自动禁用 mapping 失败:`,
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      this.autoDisableInFlight.delete(mappingId);
    }
  }

  private async doSync(mapping: SyncMapping, reason: SyncTriggerReason): Promise<DoSyncResult> {
    if (!this.running || this.dbClosed || this.db.isClosed) {
      return { pullTouchPaths: [] };
    }

    console.log(
      `[Scheduler][${mapping.mappingId}] START trigger=${formatSyncTriggerReason(reason)}` +
        ` direction=${mapping.syncDirection ?? this.config.syncDirection ?? 'bidirectional'}` +
        ` localRoot="${mapping.localRoot}" projectId=${mapping.projectId ?? '-'} rootFileId=${mapping.remoteRootFileId ?? '-'}`,
    );

    const mappingState = this.db.getMappingState(mapping.mappingId);
    const fileRecordCount = this.db.countFileStates(mapping.mappingId);

    const rootCheck = inspectLocalRoot(mapping.localRoot);
    if (!rootCheck.ok) {
      if (
        rootCheck.reason === 'missing' &&
        hasMappingSyncHistory(mappingState, fileRecordCount)
      ) {
        this.suspendMapping(mapping.mappingId, 'localRoot 缺失');
        const msg =
          `${rootCheck.detail}；localRoot 从有到无，已挂起同步并将自动禁用 mapping`;
        console.error(`[Scheduler][${mapping.mappingId}] ${msg}`);
        this.db.upsertMappingState({
          mappingId: mapping.mappingId,
          lastError: msg,
        });
        return {
          pullTouchPaths: [],
          errorMsg: msg,
          shouldDisableMapping: true,
          disableCause: 'missing-local-root',
        };
      }

      const msg = `${rootCheck.detail}（已跳过本轮同步，避免误删远端知识库）`;
      console.error(`[Scheduler][${mapping.mappingId}] ${msg}`);
      this.db.upsertMappingState({
        mappingId: mapping.mappingId,
        lastError: msg,
      });
      return { pullTouchPaths: [], errorMsg: msg };
    }

    // 读取上次同步状态（含水位 + 已缓存的远端 ID，一次查询复用）
    const lastSyncSince =
      mappingState?.lastSyncSince != null ? mappingState.lastSyncSince : undefined;

    const fullReconcileIntervalSec =
      this.config.fullReconcileIntervalSec ?? DEFAULT_FULL_RECONCILE_INTERVAL_SEC;
    const forceFullScan = this.shouldForceFullScan(mappingState, fullReconcileIntervalSec);
    const effectiveAppKey = (mapping.appKey ?? this.config.appKey ?? '').trim();
    const limiter = this.getLimiter(effectiveAppKey);
    const api = new KbApiClient(this.config.serverUrl, effectiveAppKey, limiter);
    const scope = resolveSyncScopeOptions(mapping, this.config);
    const localFs = new LocalFsAdapter(mapping.localRoot, scope);

    const remoteFs = new RemoteFsAdapter(api, {
      mappingId: mapping.mappingId,
      projectId: mapping.projectId,
      remoteRootFileId: mapping.remoteRootFileId,
      remoteRootFolderPath: mapping.remoteRootFolderPath,
      // 始终传入 SQLite 缓存：init() 内部按 "显式配置 > 缓存 > API 解析" 优先级处理。
      // 用户修改 remoteRootFolderPath/projectId 后 Web UI 会调 clearResolvedCache 使缓存失效。
      cachedRootFileId: mappingState?.resolvedRootFileId ?? undefined,
      cachedProjectId: mappingState?.resolvedProjectId ?? undefined,
      filePatterns: scope.filePatterns,
      excludePatterns: scope.excludePatterns,
      syncDotFiles: scope.syncDotFiles,
      maxFileSizeBytes: this.config.maxFileSizeBytes,
    });

    // init() 解析并返回确定的 projectId / rootFileId，写回 SQLite 缓存
    const initResult = await remoteFs.init();
    if (!initResult.ok) {
      const msg = `远端初始化失败: ${initResult.error}`;
      console.error(`[Scheduler][${mapping.mappingId}] ${msg}`);
      this.db.upsertMappingState({ mappingId: mapping.mappingId, lastError: msg });
      return {
        pullTouchPaths: [],
        errorMsg: msg,
        permanentError: classifyPermanentSyncFailure(msg)?.message,
      };
    }
    const resolved: RemoteFsInitResult = initResult.value;
    this.db.upsertMappingState({
      mappingId: mapping.mappingId,
      resolvedRootFileId: resolved.rootFileId,
      resolvedProjectId: resolved.projectId,
    });
    if (
      mappingState?.resolvedProjectId !== resolved.projectId ||
      mappingState?.resolvedRootFileId !== resolved.rootFileId
    ) {
      console.log(
        `[Scheduler][${mapping.mappingId}] REMOTE_RESOLVED projectId=${resolved.projectId}` +
          ` rootFileId=${resolved.rootFileId} path="${resolved.rootFolderPath}"`,
      );
    }

    const engine = new SyncEngine(
      localFs,
      remoteFs,
      this.db,
      { ...mapping, syncDirection: mapping.syncDirection ?? this.config.syncDirection, syncDotFiles: scope.syncDotFiles },
      {
        downloadConcurrency: this.config.downloadConcurrency ?? DOWNLOAD_CONCURRENCY,
        uploadConcurrency: this.config.uploadConcurrency ?? UPLOAD_CONCURRENCY,
        maxFileSizeBytes: this.config.maxFileSizeBytes,
        massSyncProtectionEnabled:
          mapping.massSyncProtectionEnabled ??
          this.config.massSyncProtectionEnabled ??
          DEFAULT_MASS_SYNC_PROTECTION_ENABLED,
        maxUploadFilesPerSync:
          mapping.maxUploadFilesPerSync ??
          this.config.maxUploadFilesPerSync ??
          DEFAULT_MAX_UPLOAD_FILES_PER_SYNC,
        maxDownloadFilesPerSync:
          mapping.maxDownloadFilesPerSync ??
          this.config.maxDownloadFilesPerSync ??
          DEFAULT_MAX_DOWNLOAD_FILES_PER_SYNC,
      },
    );

    let stats: SyncStats;
    let pullTouchPaths: string[] = [];
    try {
      stats = await engine.runSync(
        undefined,
        lastSyncSince,
        {
          forceFullScan: forceFullScan.force,
          forceFullScanReason: forceFullScan.reason,
        },
      );
      pullTouchPaths = engine.getPullLocalTouchPaths();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Scheduler][${mapping.mappingId}] 同步异常:`, msg);
      this.db.upsertMappingState({
        mappingId: mapping.mappingId,
        lastError: msg,
      });
      if (isMassSyncProtectionError(e)) {
        this.suspendMapping(mapping.mappingId, '大批量同步保护');
        const stats: SyncStats = {
          uploaded: 0,
          downloaded: 0,
          deleted: 0,
          skipped: e.trip.uploadCount + e.trip.downloadCount,
          failed: 1,
          errors: [msg],
          renamed: 0,
          moved: 0,
          localTombstoned: 0,
        };
        return {
          pullTouchPaths,
          stats,
          errorMsg: msg,
          shouldDisableMapping: true,
          disableCause: 'mass-sync-protection',
        };
      }
      return {
        pullTouchPaths,
        errorMsg: msg,
        permanentError: classifyPermanentSyncFailure(msg)?.message,
      };
    }

    // 仅在无系统性失败时推进水位
    if (stats.failed === 0 && stats.newSince) {
      const guardWarning =
        (stats.blockedRemoteDeletes ?? 0) > 0
          ? `远端删除保护: 本地工作区异常，已阻断 ${stats.blockedRemoteDeletes} 项远端删除并改为拉取，请确认 localRoot 是否正常`
          : null;
      this.db.upsertMappingState({
        mappingId: mapping.mappingId,
        lastSyncSince: stats.newSince,
        lastServerTime: stats.newSince,
        lastSuccessAt: Date.now(),
        ...(stats.fullScan ? { lastFullScanAt: Date.now() } : {}),
        lastError: guardWarning,
        lastStats: stats,
      });
    } else if (stats.failed > 0) {
      const errSummary = stats.errors.slice(0, 3).join('; ');
      this.db.upsertMappingState({
        mappingId: mapping.mappingId,
        lastError: `${stats.failed} 个文件失败: ${errSummary}`,
        lastStats: stats,
      });
      console.warn(
        `[Scheduler][${mapping.mappingId}] 存在 ${stats.failed} 个失败文件，水位未推进，下轮将重试`,
      );
    }

    return {
      pullTouchPaths,
      stats,
      permanentError: engine.getPermanentFailure()?.message,
    };
  }

  private shouldSkipForCircuit(mappingId: string): boolean {
    const breaker = this.circuitBreakers.get(mappingId);
    if (!breaker || breaker.until <= Date.now()) return false;
    const now = Date.now();
    if (!breaker.lastSkipLogAt || now - breaker.lastSkipLogAt >= 60_000) {
      breaker.lastSkipLogAt = now;
      console.warn(
        `[Scheduler][${mappingId}] 永久错误熔断中，跳过自动同步；` +
          `下次探测 ${new Date(breaker.until).toLocaleString('zh-CN')}，手动同步可立即探测`,
      );
    }
    return true;
  }

  private tripCircuit(mappingId: string, reason: string): void {
    const previous = this.circuitBreakers.get(mappingId);
    const level = Math.min((previous?.level ?? 0) + 1, 32);
    const delayMs = permanentCircuitDelayMs(
      level,
      PERMANENT_ERROR_CIRCUIT_BASE_MS,
      PERMANENT_ERROR_CIRCUIT_MAX_MS,
    );
    const now = Date.now();
    this.circuitBreakers.set(mappingId, {
      level,
      trippedAt: now,
      until: now + delayMs,
      reason: reason.slice(0, 800),
    });
    this.db.setMappingCircuitBreaker(mappingId, level, now + delayMs, reason.slice(0, 800));
    console.error(
      `[Scheduler][${mappingId}] 已开启永久错误熔断 level=${level} cooldown=${Math.round(delayMs / 60_000)}min: ${reason}`,
    );
  }

  private clearCircuit(mappingId: string): void {
    const existed = this.circuitBreakers.delete(mappingId);
    if (!existed) return;
    this.db.clearMappingCircuitBreaker(mappingId);
    console.log(`[Scheduler][${mappingId}] 同步成功，永久错误熔断已解除`);
  }

  /** 获取当前生效的配置（供 ManagementApi 读取） */
  getConfig(): SyncConfig {
    return this.config;
  }

  private shouldForceFullScan(
    mappingState: ReturnType<SyncStateDb['getMappingState']>,
    intervalSec: number,
  ): { force: boolean; reason?: string } {
    if (intervalSec <= 0) return { force: false };
    if (!mappingState?.lastSyncSince) return { force: false };
    if (!mappingState.lastFullScanAt) {
      return { force: true, reason: '尚未记录成功的全量对账' };
    }

    const elapsedMs = Date.now() - mappingState.lastFullScanAt;
    if (elapsedMs >= intervalSec * 1000) {
      return {
        force: true,
        reason: `距上次全量对账已 ${Math.round(elapsedMs / 1000)}s，超过配置间隔 ${intervalSec}s`,
      };
    }

    return { force: false };
  }

  /**
   * 完全重置指定 mapping 的同步状态（文件记录 + 水位 + 远端 ID 缓存）。
   * 修改身份字段（localRoot / remoteRootFolderPath / projectId / appKey）后调用，
   * 确保下次同步以全量对账模式重建正确基准，而非用旧状态做错误决策。
   */
  resetMappingState(mappingId: string): void {
    if (this.dbClosed) return;
    this.db.resetMappingState(mappingId);
    this.circuitBreakers.delete(mappingId);
    console.log(`[Scheduler] 已重置 mapping 同步状态: ${mappingId}`);
  }

  /** 获取所有 mapping 的当前状态摘要 */
  getStatus(): Record<
    string,
    {
      isSyncing: boolean;
      pendingSync: boolean;
      syncSuspended: boolean;
      lastTriggerReason?: SyncTriggerReason;
      lastWatchTriggerAt?: number;
      watchActive: boolean;
      circuitOpen: boolean;
      circuitUntil?: number;
      circuitReason?: string;
      lastState: unknown;
    }
  > {
    const result: Record<
      string,
      {
        isSyncing: boolean;
        pendingSync: boolean;
        syncSuspended: boolean;
        lastTriggerReason?: SyncTriggerReason;
        lastWatchTriggerAt?: number;
        watchActive: boolean;
        circuitOpen: boolean;
        circuitUntil?: number;
        circuitReason?: string;
        lastState: unknown;
      }
    > = {};
    for (const [mappingId, runState] of this.runStates) {
      const breaker = this.circuitBreakers.get(mappingId);
      result[mappingId] = {
        isSyncing: runState.isSyncing,
        pendingSync: runState.pendingSync,
        syncSuspended: this.suspendedMappingIds.has(mappingId),
        lastTriggerReason: runState.lastTriggerReason,
        lastWatchTriggerAt: runState.lastWatchTriggerAt,
        watchActive: this.watchers.get(mappingId)?.isActive() ?? false,
        circuitOpen: (breaker?.until ?? 0) > Date.now(),
        circuitUntil: breaker?.until,
        circuitReason: breaker?.reason,
        lastState: this.dbClosed ? null : this.db.getMappingState(mappingId),
      };
    }
    return result;
  }
}

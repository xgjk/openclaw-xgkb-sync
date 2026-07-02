import * as path from 'path';
import { maybeScheduleAutoUpgrade } from './autoUpgrade';
import { buildReportedConfig } from './centralConfigMerge';
import { resolveMaxConcurrentMappings } from './scheduler';
import { SyncScheduler } from './scheduler';
import { MappingSyncRunResult, SyncConfig } from './types';
import { DEFAULT_CENTRAL_HEARTBEAT_INTERVAL_SEC } from './constants';
import { isNewerVersion } from './versionCompare';
import { resolveMappingSyncDirection } from './watchHelpers';

export interface CentralMappingStatPayload {
  mappingId: string;
  /** 实际生效的同步方向（含继承全局） */
  syncDirection: SyncConfig['syncDirection'];
  lastSyncAt?: number | null;
  lastTriggerReason?: string | null;
  uploaded?: number;
  downloaded?: number;
  deleted?: number;
  failed?: number;
  errors?: string[];
}

export interface HeartbeatResponseData {
  configVersion?: number;
  latestAppVersion?: string;
  config?: Record<string, unknown> | null;
}

export interface CentralReporterOptions {
  getNodeIdentity: () => { nodeId: string; advertiseIp: string };
  configPath: string;
  projectRoot: string;
  appVersion: string;
  getConfig: () => SyncConfig;
  getScheduler: () => SyncScheduler;
  getEventLoopLagMs: () => number;
}

/** 是否启用自动升级（默认开启，仅显式 false 关闭） */
export function isAutoUpgradeEnabled(config: SyncConfig): boolean {
  return config.autoUpgradeEnabled !== false;
}

export class CentralReporter {
  private readonly opts: CentralReporterOptions;
  private timer: NodeJS.Timeout | null = null;
  private heartbeatInFlight = false;
  private stopped = false;

  constructor(opts: CentralReporterOptions) {
    this.opts = opts;
  }

  start(): void {
    const config = this.opts.getConfig();
    const url = config.centralManagerUrl?.trim();
    if (!url) {
      console.log('[CentralReporter] 未配置 centralManagerUrl，跳过 sync-manage 上报');
      return;
    }

    const intervalSec = Math.max(
      15,
      config.centralHeartbeatIntervalSec ?? DEFAULT_CENTRAL_HEARTBEAT_INTERVAL_SEC,
    );

    const upgradeHint = isAutoUpgradeEnabled(config) ? '自动升级已启用' : '自动升级已关闭';
    console.log(
      `[CentralReporter] 已启用，目标 ${url}，心跳间隔 ${intervalSec}s，nodeId=${this.opts.getNodeIdentity().nodeId}，${upgradeHint}`,
    );

    const tick = () => void this.sendHeartbeat().catch((e) => {
      console.warn(
        '[CentralReporter] 心跳异常:',
        e instanceof Error ? e.message : String(e),
      );
    });

    tick();
    this.timer = setInterval(tick, intervalSec * 1000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 配置变更后重启心跳定时器（如 Web 保存 centralManagerUrl） */
  restart(): void {
    this.stop();
    this.stopped = false;
    this.heartbeatInFlight = false;
    this.start();
  }

  /** mapping 同步结束后上报 execution-log */
  reportExecutionLog(result: MappingSyncRunResult): void {
    const config = this.opts.getConfig();
    const baseUrl = config.centralManagerUrl?.trim();
    if (!baseUrl || this.stopped) return;

    const mapping = config.mappings.find((m) => m.mappingId === result.mappingId);
    const syncDirection = mapping
      ? resolveMappingSyncDirection(mapping, config.syncDirection)
      : config.syncDirection;

    const body = {
      mappingId: result.mappingId,
      syncDirection,
      triggerReason: result.triggerReason,
      startTime: result.startTime,
      endTime: result.endTime,
      uploaded: result.uploaded,
      downloaded: result.downloaded,
      deleted: result.deleted,
      skipped: result.skipped,
      failed: result.failed,
      ...(result.errorMsg ? { errorMsg: result.errorMsg } : {}),
    };

    void this.postJson(baseUrl, '/nologin/node/execution-log', body).catch((e) => {
      console.warn(
        `[CentralReporter] execution-log 上报失败 (${result.mappingId}):`,
        e instanceof Error ? e.message : String(e),
      );
    });
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.stopped || this.heartbeatInFlight) return;

    const config = this.opts.getConfig();
    const baseUrl = config.centralManagerUrl?.trim();
    if (!baseUrl) return;

    this.heartbeatInFlight = true;
    try {
      const scheduler = this.opts.getScheduler();
      const pressure = scheduler.getGlobalSyncPressure();
      const maxConcurrent = resolveMaxConcurrentMappings(config);
      const identity = this.opts.getNodeIdentity();

      const body = {
        version: this.opts.appVersion,
        ipAddress: identity.advertiseIp,
        eventLoopLagMs: this.opts.getEventLoopLagMs(),
        globalSyncRunning: pressure.running,
        globalSyncMax: maxConcurrent,
        appKey: config.appKey ?? '',
        mappingStats: this.buildMappingStats(scheduler),
        localConfigVersion: config.localConfigVersion ?? 0,
        reportedConfig: buildReportedConfig(config),
      };

      const data = await this.postJson<HeartbeatResponseData>(
        baseUrl,
        '/nologin/node/heartbeat',
        body,
      );

      const latest = data.latestAppVersion?.trim();
      if (latest && isAutoUpgradeEnabled(config)) {
        if (isNewerVersion(latest, this.opts.appVersion)) {
          console.log(
            `[CentralReporter] 中心发布新版本 ${latest}（当前 ${this.opts.appVersion}），检查是否可自动升级…`,
          );
        }
        maybeScheduleAutoUpgrade(latest, {
          enabled: true,
          scriptPath: config.autoUpgradeScript,
          projectRoot: this.opts.projectRoot,
          currentVersion: this.opts.appVersion,
          isSyncIdle: () => scheduler.isSyncIdle(),
          log: (msg) => console.log(msg),
        });
      }

      // 节点侧自行维护 config.json，暂不应用中心下发的 config
      if (data.config && typeof data.config === 'object') {
        console.log(
          '[CentralReporter] 心跳响应含 config 字段，已忽略（节点配置由本地 Web/文件维护）',
        );
      }
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private buildMappingStats(
    scheduler: SyncScheduler,
  ): Record<string, CentralMappingStatPayload> {
    const config = this.opts.getConfig();
    const runStatus = scheduler.getStatus();
    const out: Record<string, CentralMappingStatPayload> = {};

    for (const mapping of config.mappings) {
      const mappingId = mapping.mappingId;
      const state = runStatus[mappingId];
      const lastState = state?.lastState as {
        lastSuccessAt?: number | null;
        lastStats?: {
          uploaded?: number;
          downloaded?: number;
          deleted?: number;
          failed?: number;
          errors?: string[];
        } | null;
      } | null;

      const stats = lastState?.lastStats;
      out[mappingId] = {
        mappingId,
        syncDirection: resolveMappingSyncDirection(mapping, config.syncDirection),
        lastSyncAt: lastState?.lastSuccessAt ?? null,
        lastTriggerReason: state?.lastTriggerReason ?? null,
        uploaded: stats?.uploaded ?? 0,
        downloaded: stats?.downloaded ?? 0,
        deleted: stats?.deleted ?? 0,
        failed: stats?.failed ?? 0,
        errors: stats?.errors?.slice(0, 5) ?? [],
      };
    }

    return out;
  }

  private async postJson<T>(
    baseUrl: string,
    apiPath: string,
    body: unknown,
  ): Promise<T> {
    const url = `${baseUrl.replace(/\/+$/, '')}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Node-Id': this.opts.getNodeIdentity().nodeId,
      },
      body: JSON.stringify(body),
    });

    const text = await resp.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`HTTP ${resp.status} 响应非 JSON: ${text.slice(0, 200)}`);
    }

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }

    const envelope = json as {
      resultCode?: number;
      resultMsg?: string;
      data?: T;
      success?: boolean;
    };

    const ok =
      envelope.resultCode === 1 ||
      envelope.resultCode === 200 ||
      envelope.success === true;

    if (!ok) {
      throw new Error(
        envelope.resultMsg ?? `sync-manage 返回 resultCode=${envelope.resultCode}`,
      );
    }

    return (envelope.data ?? {}) as T;
  }
}

/** 项目根目录（含 package.json） */
export function resolveProjectRoot(): string {
  return path.resolve(__dirname, '..');
}

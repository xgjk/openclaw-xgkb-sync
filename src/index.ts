import * as path from 'path';
import { installConsoleTee } from './consoleTee';
import { DEFAULT_MANAGEMENT_HOST, DEFAULT_MANAGEMENT_PORT, DEFAULT_LOG_DIR } from './constants';
import { loadConfigWithMeta, setMappingEnabledInConfigFile } from './config';
import { SyncScheduler } from './scheduler';
import { ManagementApi, ReloadResult } from './managementApi';
import { describeNodeIdentity, NodeIdentityError } from './nodeIdentity';
import { CentralReporter, resolveProjectRoot } from './centralReporter';
import { APP_VERSION } from './version';
import { SyncConfig } from './types';

function parseArgs(): { configPath: string; logFile?: string; logDir?: string; noLogFile?: boolean } {
  const args = process.argv.slice(2);
  let configPath = './config.json';
  let logFile: string | undefined;
  let logDir: string | undefined;
  let noLogFile = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) {
      configPath = args[++i];
    } else if (args[i] === '--log-file' && args[i + 1]) {
      logFile = args[++i];
    } else if (args[i] === '--log-dir' && args[i + 1]) {
      logDir = args[++i];
    } else if (args[i] === '--no-log-file') {
      noLogFile = true;
    }
  }

  return { configPath, logFile, logDir, noLogFile };
}

function resolveLogTeeOptions(opts: {
  logFileArg?: string;
  logDirArg?: string;
  noLogFile?: boolean;
}): Parameters<typeof installConsoleTee>[0] | undefined {
  if (opts.noLogFile) return undefined;
  const fromEnvFile = process.env.OPENCLAW_SYNC_LOG_FILE?.trim();
  const fromEnvDir = process.env.OPENCLAW_SYNC_LOG_DIR?.trim();
  if (opts.logFileArg) return { logFile: path.resolve(opts.logFileArg) };
  if (fromEnvFile) return { logFile: path.resolve(fromEnvFile) };
  if (opts.logDirArg) return { logDir: path.resolve(opts.logDirArg) };
  if (fromEnvDir) return { logDir: path.resolve(fromEnvDir) };
  return { logDir: path.resolve(DEFAULT_LOG_DIR) };
}

async function main() {
  const { configPath, logFile: logFileArg, logDir: logDirArg, noLogFile } = parseArgs();
  const logTeeOptions = resolveLogTeeOptions({ logFileArg, logDirArg, noLogFile });
  if (logTeeOptions) {
    installConsoleTee(logTeeOptions);
  }

  const absConfigPath = path.resolve(configPath);

  console.log(`[OpenClaw Sync] 启动中...`);
  console.log(`[OpenClaw Sync] 配置文件: ${absConfigPath}`);

  let config;
  let configBootstrapped = false;
  try {
    const loaded = loadConfigWithMeta(absConfigPath);
    config = loaded.config;
    configBootstrapped = loaded.bootstrapped;
  } catch (e) {
    console.error('[OpenClaw Sync] 配置加载失败:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  if (configBootstrapped) {
    const port = config.managementPort ?? 9090;
    const host = config.managementHost ?? DEFAULT_MANAGEMENT_HOST;
    const uiHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log(
      `[OpenClaw Sync] 请在 Web 控制台补充 AppKey 与同步映射: http://${uiHost}:${port}/`,
    );
  }

  console.log(`[OpenClaw Sync] serverUrl: ${config.serverUrl}`);
  console.log(`[OpenClaw Sync] 同步方向: ${config.syncDirection}`);
  console.log(
    `[OpenClaw Sync] mapping 数量: ${config.mappings.length}（已启用: ${config.mappings.filter((m) => m.enabled).length}）`,
  );

  function resolveNodeIdentity(cfg: SyncConfig) {
    return describeNodeIdentity({
      nodeId: cfg.nodeId,
      advertiseIp: cfg.nodeAdvertiseIp,
      excludeInterfaces: cfg.nodeExcludeInterfaces,
      managementPort: cfg.managementPort ?? DEFAULT_MANAGEMENT_PORT,
    });
  }

  let nodeIdentity;
  try {
    nodeIdentity = resolveNodeIdentity(config);
    console.log(
      `[OpenClaw Sync] nodeId=${nodeIdentity.nodeId} advertiseIp=${nodeIdentity.advertiseIp} (source=${nodeIdentity.source})`,
    );
  } catch (e) {
    if (e instanceof NodeIdentityError) {
      console.error('[OpenClaw Sync] 节点身份解析失败:', e.message);
      process.exit(1);
    }
    throw e;
  }

  // 用可变引用包装 scheduler，reload 时替换其中的实例
  let centralReporter: CentralReporter | null = null;
  let handleMappingAutoDisable:
    | ((
        mappingId: string,
        detail: string,
        cause: 'missing-local-root' | 'mass-sync-protection',
      ) => Promise<void>)
    | undefined;

  function createScheduler(cfg: SyncConfig): SyncScheduler {
    return new SyncScheduler(cfg, {
      onMappingSyncFinished: (result) => {
        centralReporter?.reportExecutionLog(result);
      },
      onMappingAutoDisable: async (mappingId, detail, cause) => {
        if (handleMappingAutoDisable) {
          await handleMappingAutoDisable(mappingId, detail, cause);
        }
      },
    });
  }

  const schedulerRef = { current: createScheduler(config) };

  // 热重载：等待旧 scheduler 排空并关闭 DB 后，再重建（防止错峰 timer 访问已关闭的 DB）
  let reloadInFlight: Promise<ReloadResult> | null = null;

  async function doReload(): Promise<ReloadResult> {
    if (reloadInFlight) return reloadInFlight;

    reloadInFlight = (async (): Promise<ReloadResult> => {
      let newConfig;
      try {
        newConfig = loadConfigWithMeta(absConfigPath).config;
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      console.log('[OpenClaw Sync] 配置重载：停止旧调度器...');
      const stopped = await schedulerRef.current.stop({ resumeOnTimeout: true });
      if (!stopped) {
        return {
          ok: false,
          error:
            '旧调度器仍有同步未完成，已跳过重载并恢复旧配置继续调度；请稍后重试重载或重启进程',
        };
      }
      schedulerRef.current = createScheduler(newConfig);
      schedulerRef.current.start();
      console.log('[OpenClaw Sync] 配置重载完成');
      centralReporter?.restart();
      return { ok: true, config: newConfig };
    })();

    try {
      return await reloadInFlight;
    } finally {
      reloadInFlight = null;
    }
  }

  handleMappingAutoDisable = async (
    mappingId: string,
    detail: string,
    cause: 'missing-local-root' | 'mass-sync-protection',
  ) => {
    const causeLabel = cause === 'mass-sync-protection' ? '大批量同步保护' : 'localRoot 缺失';
    console.error(
      `[OpenClaw Sync] ${causeLabel}，自动禁用 mapping "${mappingId}": ${detail}`,
    );
    const writeResult = setMappingEnabledInConfigFile(absConfigPath, mappingId, false);
    if (!writeResult.ok) {
      throw new Error(writeResult.error);
    }
    if (!writeResult.changed) {
      console.log(`[OpenClaw Sync] mapping "${mappingId}" 已是禁用状态，跳过热重载`);
      return;
    }
    const reloadResult = await doReload();
    if (!reloadResult.ok) {
      throw new Error(`禁用后热重载失败: ${reloadResult.error}`);
    }
    console.log(
      `[OpenClaw Sync] mapping "${mappingId}" 已因${causeLabel}禁用并完成热重载`,
    );
  };

  // 管理 API（HTTP 服务，port=0 时自动禁用）
  const managementApi = new ManagementApi({
    port: config.managementPort ?? 9090,
    host: config.managementHost ?? DEFAULT_MANAGEMENT_HOST,
    configPath: absConfigPath,
    getNodeIdentity: () => resolveNodeIdentity(schedulerRef.current.getConfig()),
    getScheduler: () => schedulerRef.current,
    onReload: doReload,
  });
  managementApi.start();

  centralReporter = new CentralReporter({
    getNodeIdentity: () => resolveNodeIdentity(schedulerRef.current.getConfig()),
    configPath: absConfigPath,
    projectRoot: resolveProjectRoot(),
    appVersion: APP_VERSION,
    getConfig: () => schedulerRef.current.getConfig(),
    getScheduler: () => schedulerRef.current,
    getEventLoopLagMs: () => managementApi.getEventLoopLagMs(),
  });
  centralReporter.start();

  // 优雅退出
  async function shutdown(signal: string) {
    console.log(`\n[OpenClaw Sync] 收到 ${signal}，正在停止...`);
    centralReporter?.stop();
    managementApi.stop();
    await schedulerRef.current.stop();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 未捕获异常记录但不崩溃（调度器会在下轮重试）
  process.on('uncaughtException', (e) => {
    console.error('[OpenClaw Sync] 未捕获异常:', e);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[OpenClaw Sync] 未处理的 Promise 拒绝:', reason);
  });

  schedulerRef.current.start();

  console.log('[OpenClaw Sync] 服务已启动，按 Ctrl+C 停止');
}

main().catch((e) => {
  console.error('[OpenClaw Sync] 启动失败:', e);
  process.exit(1);
});

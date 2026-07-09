import { spawn, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isNewerVersion } from './versionCompare';

export interface AutoUpgradeOptions {
  enabled: boolean;
  /** 相对项目根目录或绝对路径 */
  scriptPath?: string;
  projectRoot: string;
  currentVersion: string;
  /** 是否有进行中的同步（为 true 时推迟升级） */
  isSyncIdle: () => boolean;
  log?: (msg: string) => void;
}

let upgradeInFlight = false;
let lastAttemptedTarget: string | null = null;

/**
 * 心跳发现新版本后的升级入口。
 * Node 进程无法安全地替换正在运行的自身代码，因此委托外部脚本完成：
 * git pull / npm install / build / pm2|systemd 重启。
 */
export function maybeScheduleAutoUpgrade(
  latestAppVersion: string | undefined,
  opts: AutoUpgradeOptions,
): void {
  if (!opts.enabled || !latestAppVersion?.trim()) return;
  const latest = latestAppVersion.trim();
  const current = opts.currentVersion.trim();
  if (!current || current === 'unknown') return;
  if (!isNewerVersion(latest, current)) return;
  if (upgradeInFlight) return;
  if (lastAttemptedTarget === latest) return;

  if (!opts.isSyncIdle()) {
    opts.log?.(
      `[AutoUpgrade] 发现新版本 ${latest}（当前 ${current}），同步进行中，推迟升级`,
    );
    return;
  }

  const script = resolveUpgradeScript(opts.projectRoot, opts.scriptPath);
  if (!fs.existsSync(script)) {
    opts.log?.(`[AutoUpgrade] 升级脚本不存在: ${script}，请部署 scripts/auto-upgrade.*`);
    return;
  }

  upgradeInFlight = true;
  lastAttemptedTarget = latest;

  const spawnSpec = buildUpgradeSpawnSpec(script, latest, current);
  opts.log?.(
    `[AutoUpgrade] 触发升级 ${current} -> ${latest}，命令: ${spawnSpec.command} ${spawnSpec.args.join(' ')}`,
  );

  const spawnOpts: SpawnOptions = {
    cwd: opts.projectRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      OPENCLAW_SYNC_TARGET_VERSION: latest,
      OPENCLAW_SYNC_CURRENT_VERSION: current,
      /** 与当前运行进程相同的 node，供升级脚本 build/重启（避免 Mac nvm PATH 丢失） */
      OPENCLAW_SYNC_NODE: process.execPath,
      OPENCLAW_SYNC_PROJECT_ROOT: opts.projectRoot,
    },
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
  };

  const child = spawn(spawnSpec.command, spawnSpec.args, spawnOpts);
  child.unref();

  child.on('error', (e) => {
    upgradeInFlight = false;
    lastAttemptedTarget = null;
    opts.log?.(`[AutoUpgrade] 启动升级脚本失败: ${e instanceof Error ? e.message : String(e)}`);
  });

  // 脚本负责停服与重启；本进程可能被 SIGTERM，不再在这里 reset upgradeInFlight
}

/** 通过解释器启动，避免 Mac/Linux clone 后 .sh 无 +x 导致 EACCES */
export function buildUpgradeSpawnSpec(
  script: string,
  targetVersion: string,
  currentVersion: string,
): { command: string; args: string[] } {
  const ext = path.extname(script).toLowerCase();

  if (ext === '.ps1' || (process.platform === 'win32' && ext !== '.sh')) {
    return {
      command: resolveWindowsPowerShell(),
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        targetVersion,
        currentVersion,
      ],
    };
  }

  return {
    command: resolveUnixBash(),
    args: [script, targetVersion, currentVersion],
  };
}

function resolveUnixBash(): string {
  if (fs.existsSync('/bin/bash')) return '/bin/bash';
  return 'bash';
}

function resolveWindowsPowerShell(): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const pwsh = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(pwsh)) return pwsh;
  return 'powershell.exe';
}

function resolveUpgradeScript(projectRoot: string, configured?: string): string {
  if (configured?.trim()) {
    return path.isAbsolute(configured) ? configured : path.resolve(projectRoot, configured);
  }
  if (process.env.OPENCLAW_DEPLOYMENT === 'docker') {
    const dockerScript = path.resolve(projectRoot, 'scripts', 'auto-upgrade.docker.sh');
    if (fs.existsSync(dockerScript)) return dockerScript;
  }
  const ext = process.platform === 'win32' ? 'ps1' : 'sh';
  return path.resolve(projectRoot, 'scripts', `auto-upgrade.${ext}`);
}

import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';

/**
 * 将 console.log / warn / error 同时追加写入指定文件（UTF-8，带时间戳）。
 * 用于服务端落盘查问题，不替代 journald 等外部采集。
 */
export function installConsoleTee(absLogPath: string): void {
  const dir = path.dirname(absLogPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 目录已存在等可忽略
  }

  const stream = fs.createWriteStream(absLogPath, { flags: 'a' });
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);

  const writeLine = (level: string, args: unknown[]): void => {
    const line = `[${new Date().toISOString()}] [${level}] ${util.format(...args)}\n`;
    stream.write(line);
  };

  console.log = (...args: unknown[]) => {
    origLog(...args);
    writeLine('INFO', args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    writeLine('WARN', args);
  };
  console.error = (...args: unknown[]) => {
    origErr(...args);
    writeLine('ERROR', args);
  };

  origLog(`[OpenClaw Sync] 日志已双写到: ${absLogPath}`);
  stream.write(
    `[${new Date().toISOString()}] [INFO] [OpenClaw Sync] 日志文件: ${absLogPath}\n`,
  );
}

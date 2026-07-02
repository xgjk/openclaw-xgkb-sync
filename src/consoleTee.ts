import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import {
  DEFAULT_LOG_BASE_NAME,
  DEFAULT_LOG_DIR,
  MAX_LOG_FILE_BYTES,
} from './constants';

export interface ConsoleTeeOptions {
  /** 日志目录；与 logFile 二选一 */
  logDir?: string;
  /**
   * 显式日志路径（兼容 --log-file）。
   * 使用其所在目录，文件名（去 .log）作为 baseName。
   */
  logFile?: string;
  baseName?: string;
  maxFileBytes?: number;
}

function formatLogDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildLogFileName(baseName: string, date: string, segment: number): string {
  if (segment <= 0) return `${baseName}-${date}.log`;
  return `${baseName}-${date}.${segment}.log`;
}

const LOG_FILE_NAME_RE = /^(.+)-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;

function parseLogFileName(fileName: string): {
  baseName: string;
  date: string;
  segment: number;
} | null {
  const m = fileName.match(LOG_FILE_NAME_RE);
  if (!m) return null;
  return {
    baseName: m[1],
    date: m[2],
    segment: m[3] ? Number(m[3]) : 0,
  };
}

function resolveTeeTarget(opts: ConsoleTeeOptions): {
  logDir: string;
  baseName: string;
  maxFileBytes: number;
} {
  const maxFileBytes = opts.maxFileBytes ?? MAX_LOG_FILE_BYTES;

  if (opts.logFile?.trim()) {
    const abs = path.resolve(opts.logFile.trim());
    const fileName = path.basename(abs);
    const parsed = parseLogFileName(fileName);
    if (parsed) {
      return {
        logDir: path.dirname(abs),
        baseName: parsed.baseName,
        maxFileBytes,
      };
    }
    const base = path.basename(abs, '.log');
    return {
      logDir: path.dirname(abs),
      baseName: base || DEFAULT_LOG_BASE_NAME,
      maxFileBytes,
    };
  }

  return {
    logDir: path.resolve(opts.logDir?.trim() || DEFAULT_LOG_DIR),
    baseName: opts.baseName?.trim() || DEFAULT_LOG_BASE_NAME,
    maxFileBytes,
  };
}

/** 选择今日可追加的日志段：未满的最后一段，或新建下一段。 */
function pickInitialLogSegment(
  logDir: string,
  baseName: string,
  date: string,
  maxFileBytes: number,
): { absPath: string; segment: number; bytesInFile: number } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const candidates: Array<{ segment: number; absPath: string; size: number }> = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const parsed = parseLogFileName(ent.name);
    if (!parsed || parsed.baseName !== baseName || parsed.date !== date) continue;
    const absPath = path.join(logDir, ent.name);
    let size = 0;
    try {
      size = fs.statSync(absPath).size;
    } catch {
      continue;
    }
    candidates.push({ segment: parsed.segment, absPath, size });
  }

  candidates.sort((a, b) => a.segment - b.segment);
  const latest = candidates[candidates.length - 1];
  if (latest && latest.size < maxFileBytes) {
    return { absPath: latest.absPath, segment: latest.segment, bytesInFile: latest.size };
  }

  const nextSegment = latest ? latest.segment + 1 : 0;
  const fileName = buildLogFileName(baseName, date, nextSegment);
  return {
    absPath: path.join(logDir, fileName),
    segment: nextSegment,
    bytesInFile: 0,
  };
}

class RotatingLogWriter {
  private readonly logDir: string;
  private readonly baseName: string;
  private readonly maxFileBytes: number;
  private currentDate: string;
  private currentSegment: number;
  private currentPath: string;
  private stream: fs.WriteStream;
  private bytesInFile: number;

  constructor(logDir: string, baseName: string, maxFileBytes: number) {
    this.logDir = logDir;
    this.baseName = baseName;
    this.maxFileBytes = maxFileBytes;
    this.currentDate = formatLogDate();

    fs.mkdirSync(this.logDir, { recursive: true });

    const initial = pickInitialLogSegment(
      this.logDir,
      this.baseName,
      this.currentDate,
      this.maxFileBytes,
    );
    this.currentSegment = initial.segment;
    this.currentPath = initial.absPath;
    this.bytesInFile = initial.bytesInFile;
    this.stream = fs.createWriteStream(this.currentPath, { flags: 'a' });
  }

  getCurrentPath(): string {
    return this.currentPath;
  }

  write(line: string): void {
    const today = formatLogDate();
    if (today !== this.currentDate) {
      this.rotateTo(today, 0);
    }

    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (this.bytesInFile > 0 && this.bytesInFile + lineBytes > this.maxFileBytes) {
      this.rotateTo(this.currentDate, this.currentSegment + 1);
    }

    this.stream.write(line);
    this.bytesInFile += lineBytes;
  }

  private rotateTo(date: string, segment: number): void {
    this.stream.end();
    this.currentDate = date;
    this.currentSegment = segment;
    this.currentPath = path.join(
      this.logDir,
      buildLogFileName(this.baseName, date, segment),
    );
    this.bytesInFile = 0;
    this.stream = fs.createWriteStream(this.currentPath, { flags: 'a' });
  }
}

/**
 * 将 console.log / warn / error 同时追加写入日志文件（UTF-8，带时间戳）。
 * 按自然日切割；单日单文件超过 maxFileBytes 时递增段号（.1、.2…）。
 */
export function installConsoleTee(opts: ConsoleTeeOptions | string): void {
  const options: ConsoleTeeOptions =
    typeof opts === 'string' ? { logFile: opts } : opts;
  const { logDir, baseName, maxFileBytes } = resolveTeeTarget(options);
  const writer = new RotatingLogWriter(logDir, baseName, maxFileBytes);

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);

  const writeLine = (level: string, args: unknown[]): void => {
    const line = `[${new Date().toISOString()}] [${level}] ${util.format(...args)}\n`;
    writer.write(line);
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

  const maxMb = Math.round(maxFileBytes / (1024 * 1024));
  origLog(
    `[OpenClaw Sync] 日志已双写: ${writer.getCurrentPath()}（按日切割，单文件 ≤${maxMb}MB）`,
  );
  writer.write(
    `[${new Date().toISOString()}] [INFO] [OpenClaw Sync] 日志目录=${logDir} base=${baseName} maxFileBytes=${maxFileBytes}\n`,
  );
}

/** @deprecated 使用 installConsoleTee({ logFile }) */
export function installConsoleTeeLegacy(absLogPath: string): void {
  installConsoleTee({ logFile: absLogPath });
}

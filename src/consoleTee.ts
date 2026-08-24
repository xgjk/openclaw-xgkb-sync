import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import {
  DEFAULT_LOG_BASE_NAME,
  DEFAULT_LOG_DIR,
  MAX_LOG_FILE_BYTES,
  MAX_LOG_TOTAL_BYTES,
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
  maxTotalBytes?: number;
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
  maxTotalBytes: number;
} {
  const maxFileBytes = opts.maxFileBytes ?? MAX_LOG_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_LOG_TOTAL_BYTES;

  if (opts.logFile?.trim()) {
    const abs = path.resolve(opts.logFile.trim());
    const fileName = path.basename(abs);
    const parsed = parseLogFileName(fileName);
    if (parsed) {
      return {
        logDir: path.dirname(abs),
        baseName: parsed.baseName,
        maxFileBytes,
        maxTotalBytes,
      };
    }
    const base = path.basename(abs, '.log');
    return {
      logDir: path.dirname(abs),
      baseName: base || DEFAULT_LOG_BASE_NAME,
      maxFileBytes,
      maxTotalBytes,
    };
  }

  return {
    logDir: path.resolve(opts.logDir?.trim() || DEFAULT_LOG_DIR),
    baseName: opts.baseName?.trim() || DEFAULT_LOG_BASE_NAME,
    maxFileBytes,
    maxTotalBytes,
  };
}

export interface LogPruneResult {
  deletedFiles: number;
  deletedBytes: number;
  remainingBytes: number;
}

/** 仅清理同一 baseName 的旧轮转分段；当前正在写入的文件始终保留。 */
export function pruneOldLogSegments(
  logDir: string,
  baseName: string,
  maxTotalBytes: number,
  protectedPath?: string,
): LogPruneResult {
  const protectedAbs = protectedPath ? path.resolve(protectedPath) : undefined;
  const files: Array<{ absPath: string; date: string; segment: number; size: number }> = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch {
    return { deletedFiles: 0, deletedBytes: 0, remainingBytes: 0 };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseLogFileName(entry.name);
    if (!parsed || parsed.baseName !== baseName) continue;
    const absPath = path.resolve(logDir, entry.name);
    try {
      files.push({
        absPath,
        date: parsed.date,
        segment: parsed.segment,
        size: fs.statSync(absPath).size,
      });
    } catch {
      // 文件可能正被外部轮转或删除，忽略。
    }
  }

  files.sort((a, b) => a.date.localeCompare(b.date) || a.segment - b.segment);
  let remainingBytes = files.reduce((sum, file) => sum + file.size, 0);
  let deletedFiles = 0;
  let deletedBytes = 0;
  for (const file of files) {
    if (remainingBytes <= maxTotalBytes) break;
    if (file.absPath === protectedAbs) continue;
    try {
      fs.unlinkSync(file.absPath);
      remainingBytes -= file.size;
      deletedBytes += file.size;
      deletedFiles++;
    } catch {
      // 日志清理失败不影响同步主流程。
    }
  }
  return { deletedFiles, deletedBytes, remainingBytes };
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
  /** 日志磁盘变慢时最多在 JS 侧保留 4 MiB；超过后舍弃旧时效日志。 */
  private static readonly MAX_PENDING_BYTES = 4 * 1024 * 1024;
  private readonly logDir: string;
  private readonly baseName: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private currentDate: string;
  private currentSegment: number;
  private currentPath: string;
  private stream: fs.WriteStream;
  private bytesInFile: number;
  private pendingLines: string[] = [];
  private pendingHead = 0;
  private pendingBytes = 0;
  private backpressured = false;
  private rotating = false;
  private droppedLines = 0;

  constructor(logDir: string, baseName: string, maxFileBytes: number, maxTotalBytes: number) {
    this.logDir = logDir;
    this.baseName = baseName;
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
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
    this.stream = this.createStream(this.currentPath);
    this.pruneOldSegments();
  }

  getCurrentPath(): string {
    return this.currentPath;
  }

  write(line: string): void {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (
      lineBytes > RotatingLogWriter.MAX_PENDING_BYTES ||
      this.pendingBytes + lineBytes > RotatingLogWriter.MAX_PENDING_BYTES
    ) {
      this.droppedLines++;
      return;
    }
    this.pendingLines.push(line);
    this.pendingBytes += lineBytes;
    this.pump();
  }

  private pump(): void {
    if (this.backpressured || this.rotating) return;

    while (this.pendingHead < this.pendingLines.length) {
      const line = this.pendingLines[this.pendingHead];
      const lineBytes = Buffer.byteLength(line, 'utf8');
      const today = formatLogDate();
      const dateChanged = today !== this.currentDate;
      const sizeExceeded =
        this.bytesInFile > 0 && this.bytesInFile + lineBytes > this.maxFileBytes;
      if (dateChanged || sizeExceeded) {
        this.rotateTo(dateChanged ? today : this.currentDate, dateChanged ? 0 : this.currentSegment + 1);
        return;
      }

      this.pendingHead++;
      this.pendingBytes -= lineBytes;
      this.bytesInFile += lineBytes;
      const accepted = this.stream.write(line);
      if (!accepted) {
        this.backpressured = true;
        this.stream.once('drain', () => {
          this.backpressured = false;
          this.compactQueue();
          this.pump();
        });
        return;
      }
    }

    this.compactQueue();
    if (this.droppedLines > 0) {
      const dropped = this.droppedLines;
      this.droppedLines = 0;
      this.write(
        `[${new Date().toISOString()}] [WARN] [ConsoleTee] 日志磁盘写入拥塞，已舍弃 ${dropped} 行日志\n`,
      );
    }
  }

  private compactQueue(): void {
    if (this.pendingHead === 0) return;
    this.pendingLines = this.pendingLines.slice(this.pendingHead);
    this.pendingHead = 0;
  }

  private rotateTo(date: string, segment: number): void {
    this.rotating = true;
    this.stream.end(() => {
      this.currentDate = date;
      this.currentSegment = segment;
      this.currentPath = path.join(
        this.logDir,
        buildLogFileName(this.baseName, date, segment),
      );
      this.bytesInFile = 0;
      this.stream = this.createStream(this.currentPath);
      this.pruneOldSegments();
      this.rotating = false;
      this.pump();
    });
  }

  private pruneOldSegments(): void {
    const result = pruneOldLogSegments(
      this.logDir,
      this.baseName,
      this.maxTotalBytes,
      this.currentPath,
    );
    if (result.deletedFiles > 0) {
      process.stderr.write(
        `[ConsoleTee] 日志保留上限清理：删除 ${result.deletedFiles} 个旧分段，` +
          `${Math.round(result.deletedBytes / (1024 * 1024))} MiB\n`,
      );
    }
  }

  private createStream(filePath: string): fs.WriteStream {
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.on('error', (e) => {
      // 不再通过 console 输出，避免日志 writer 自己递归；队列有硬上限，不会因磁盘故障失控。
      process.stderr.write(`[ConsoleTee] 写日志失败 ${filePath}: ${e.message}\n`);
    });
    return stream;
  }
}

/**
 * 将 console.log / warn / error 同时追加写入日志文件（UTF-8，带时间戳）。
 * 按自然日切割；单日单文件超过 maxFileBytes 时递增段号（.1、.2…）。
 */
export function installConsoleTee(opts: ConsoleTeeOptions | string): void {
  const options: ConsoleTeeOptions =
    typeof opts === 'string' ? { logFile: opts } : opts;
  const { logDir, baseName, maxFileBytes, maxTotalBytes } = resolveTeeTarget(options);
  const writer = new RotatingLogWriter(logDir, baseName, maxFileBytes, maxTotalBytes);

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
    `[OpenClaw Sync] 日志已双写: ${writer.getCurrentPath()}（按日切割，单文件 ≤${maxMb}MB，` +
      `总量 ≤${Math.round(maxTotalBytes / (1024 * 1024))}MB）`,
  );
  writer.write(
    `[${new Date().toISOString()}] [INFO] [OpenClaw Sync] 日志目录=${logDir} base=${baseName} maxFileBytes=${maxFileBytes}\n`,
  );
}

/** @deprecated 使用 installConsoleTee({ logFile }) */
export function installConsoleTeeLegacy(absLogPath: string): void {
  installConsoleTee({ logFile: absLogPath });
}

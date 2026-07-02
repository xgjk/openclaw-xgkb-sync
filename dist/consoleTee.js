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
Object.defineProperty(exports, "__esModule", { value: true });
exports.installConsoleTee = installConsoleTee;
exports.installConsoleTeeLegacy = installConsoleTeeLegacy;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const util = __importStar(require("util"));
const constants_1 = require("./constants");
function formatLogDate(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
function buildLogFileName(baseName, date, segment) {
    if (segment <= 0)
        return `${baseName}-${date}.log`;
    return `${baseName}-${date}.${segment}.log`;
}
const LOG_FILE_NAME_RE = /^(.+)-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;
function parseLogFileName(fileName) {
    const m = fileName.match(LOG_FILE_NAME_RE);
    if (!m)
        return null;
    return {
        baseName: m[1],
        date: m[2],
        segment: m[3] ? Number(m[3]) : 0,
    };
}
function resolveTeeTarget(opts) {
    const maxFileBytes = opts.maxFileBytes ?? constants_1.MAX_LOG_FILE_BYTES;
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
            baseName: base || constants_1.DEFAULT_LOG_BASE_NAME,
            maxFileBytes,
        };
    }
    return {
        logDir: path.resolve(opts.logDir?.trim() || constants_1.DEFAULT_LOG_DIR),
        baseName: opts.baseName?.trim() || constants_1.DEFAULT_LOG_BASE_NAME,
        maxFileBytes,
    };
}
/** 选择今日可追加的日志段：未满的最后一段，或新建下一段。 */
function pickInitialLogSegment(logDir, baseName, date, maxFileBytes) {
    let entries;
    try {
        entries = fs.readdirSync(logDir, { withFileTypes: true });
    }
    catch {
        entries = [];
    }
    const candidates = [];
    for (const ent of entries) {
        if (!ent.isFile())
            continue;
        const parsed = parseLogFileName(ent.name);
        if (!parsed || parsed.baseName !== baseName || parsed.date !== date)
            continue;
        const absPath = path.join(logDir, ent.name);
        let size = 0;
        try {
            size = fs.statSync(absPath).size;
        }
        catch {
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
    logDir;
    baseName;
    maxFileBytes;
    currentDate;
    currentSegment;
    currentPath;
    stream;
    bytesInFile;
    constructor(logDir, baseName, maxFileBytes) {
        this.logDir = logDir;
        this.baseName = baseName;
        this.maxFileBytes = maxFileBytes;
        this.currentDate = formatLogDate();
        fs.mkdirSync(this.logDir, { recursive: true });
        const initial = pickInitialLogSegment(this.logDir, this.baseName, this.currentDate, this.maxFileBytes);
        this.currentSegment = initial.segment;
        this.currentPath = initial.absPath;
        this.bytesInFile = initial.bytesInFile;
        this.stream = fs.createWriteStream(this.currentPath, { flags: 'a' });
    }
    getCurrentPath() {
        return this.currentPath;
    }
    write(line) {
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
    rotateTo(date, segment) {
        this.stream.end();
        this.currentDate = date;
        this.currentSegment = segment;
        this.currentPath = path.join(this.logDir, buildLogFileName(this.baseName, date, segment));
        this.bytesInFile = 0;
        this.stream = fs.createWriteStream(this.currentPath, { flags: 'a' });
    }
}
/**
 * 将 console.log / warn / error 同时追加写入日志文件（UTF-8，带时间戳）。
 * 按自然日切割；单日单文件超过 maxFileBytes 时递增段号（.1、.2…）。
 */
function installConsoleTee(opts) {
    const options = typeof opts === 'string' ? { logFile: opts } : opts;
    const { logDir, baseName, maxFileBytes } = resolveTeeTarget(options);
    const writer = new RotatingLogWriter(logDir, baseName, maxFileBytes);
    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origErr = console.error.bind(console);
    const writeLine = (level, args) => {
        const line = `[${new Date().toISOString()}] [${level}] ${util.format(...args)}\n`;
        writer.write(line);
    };
    console.log = (...args) => {
        origLog(...args);
        writeLine('INFO', args);
    };
    console.warn = (...args) => {
        origWarn(...args);
        writeLine('WARN', args);
    };
    console.error = (...args) => {
        origErr(...args);
        writeLine('ERROR', args);
    };
    const maxMb = Math.round(maxFileBytes / (1024 * 1024));
    origLog(`[OpenClaw Sync] 日志已双写: ${writer.getCurrentPath()}（按日切割，单文件 ≤${maxMb}MB）`);
    writer.write(`[${new Date().toISOString()}] [INFO] [OpenClaw Sync] 日志目录=${logDir} base=${baseName} maxFileBytes=${maxFileBytes}\n`);
}
/** @deprecated 使用 installConsoleTee({ logFile }) */
function installConsoleTeeLegacy(absLogPath) {
    installConsoleTee({ logFile: absLogPath });
}
//# sourceMappingURL=consoleTee.js.map
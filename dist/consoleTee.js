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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const util = __importStar(require("util"));
/**
 * 将 console.log / warn / error 同时追加写入指定文件（UTF-8，带时间戳）。
 * 用于服务端落盘查问题，不替代 journald 等外部采集。
 */
function installConsoleTee(absLogPath) {
    const dir = path.dirname(absLogPath);
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch {
        // 目录已存在等可忽略
    }
    const stream = fs.createWriteStream(absLogPath, { flags: 'a' });
    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origErr = console.error.bind(console);
    const writeLine = (level, args) => {
        const line = `[${new Date().toISOString()}] [${level}] ${util.format(...args)}\n`;
        stream.write(line);
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
    origLog(`[OpenClaw Sync] 日志已双写到: ${absLogPath}`);
    stream.write(`[${new Date().toISOString()}] [INFO] [OpenClaw Sync] 日志文件: ${absLogPath}\n`);
}
//# sourceMappingURL=consoleTee.js.map
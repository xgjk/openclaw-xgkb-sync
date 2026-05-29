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
exports.LocalFsAdapter = void 0;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const pathSanitize_1 = require("./pathSanitize");
const pathSyncScope_1 = require("./pathSyncScope");
/**
 * 本地文件系统适配器（Node.js 版）
 * 替代 Obsidian Vault API，面向标准 Node.js `fs/promises`。
 */
class LocalFsAdapter {
    localRoot;
    scope;
    constructor(localRoot, scope) {
        this.localRoot = path.resolve(localRoot);
        this.scope = scope;
    }
    getRoot() {
        return this.localRoot;
    }
    getSyncScope() {
        return this.scope;
    }
    /**
     * 递归列出 localRoot 下所有匹配 filePatterns 且不在 excludePatterns 中的文件。
     * 返回路径均为相对于 localRoot 的路径（使用 "/" 分隔）。
     */
    async listFiles() {
        const entries = [];
        await this.walk(this.localRoot, '', entries);
        return entries;
    }
    /**
     * 递归列出 localRoot 下所有纳入同步遍历范围的目录（含 dev/ino）。
     * 返回路径均为相对于 localRoot 的路径（使用 "/" 分隔），不包含根目录自身。
     */
    async listDirectories() {
        const dirs = [];
        await this.walkDirectories(this.localRoot, '', dirs);
        return dirs;
    }
    async walk(absDir, relPrefix, entries) {
        let dirEntries;
        try {
            dirEntries = await fs.readdir(absDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        const subDirTasks = [];
        for (const dirent of dirEntries) {
            if ((0, pathSyncScope_1.shouldSkipDotEntryName)(dirent.name, this.scope.syncDotFiles))
                continue;
            const relPath = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
            const absPath = path.join(absDir, dirent.name);
            if (dirent.isDirectory()) {
                if (!(0, pathSyncScope_1.isInSyncScope)(relPath, this.scope, 'directory'))
                    continue;
                subDirTasks.push(this.walk(absPath, relPath, entries));
            }
            else if (dirent.isFile()) {
                const safePath = (0, pathSanitize_1.normalizeSeparator)(relPath)
                    .split('/')
                    .map((seg) => (0, pathSanitize_1.sanitizePathSegment)(seg))
                    .join('/');
                if (!(0, pathSyncScope_1.isInSyncScope)(safePath, this.scope, 'file'))
                    continue;
                try {
                    const stat = await fs.stat(absPath, { bigint: true });
                    entries.push({
                        path: safePath,
                        name: dirent.name,
                        mtime: Number(stat.mtimeMs),
                        size: Number(stat.size),
                        dev: stat.dev.toString(),
                        ino: stat.ino.toString(),
                    });
                }
                catch {
                    // stat 失败跳过
                }
            }
        }
        if (subDirTasks.length > 0) {
            await Promise.all(subDirTasks);
        }
    }
    async walkDirectories(absDir, relPrefix, dirs) {
        let dirEntries;
        try {
            dirEntries = await fs.readdir(absDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        const subDirTasks = [];
        for (const dirent of dirEntries) {
            if ((0, pathSyncScope_1.shouldSkipDotEntryName)(dirent.name, this.scope.syncDotFiles))
                continue;
            if (!dirent.isDirectory())
                continue;
            const relPath = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
            if (!(0, pathSyncScope_1.isInSyncScope)(relPath, this.scope, 'directory'))
                continue;
            const safePath = (0, pathSanitize_1.normalizeSeparator)(relPath)
                .split('/')
                .map((seg) => (0, pathSanitize_1.sanitizePathSegment)(seg))
                .join('/');
            const absPath = path.join(absDir, dirent.name);
            try {
                const stat = await fs.stat(absPath, { bigint: true });
                dirs.push({ path: safePath, dev: stat.dev.toString(), ino: stat.ino.toString() });
            }
            catch {
                dirs.push({ path: safePath, dev: '0', ino: '0' });
            }
            subDirTasks.push(this.walkDirectories(absPath, relPath, dirs));
        }
        if (subDirTasks.length > 0) {
            await Promise.all(subDirTasks);
        }
    }
    /** 读取文件内容（UTF-8） */
    async readFile(relativePath) {
        const absPath = this.resolve(relativePath);
        return fs.readFile(absPath, 'utf-8');
    }
    /**
     * 写入文件（自动创建父目录）。
     * 返回写入后的实际 mtime。
     */
    async writeFile(relativePath, content) {
        const absPath = this.resolve(relativePath);
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, content, 'utf-8');
        const stat = await fs.stat(absPath);
        return stat.mtimeMs;
    }
    /**
     * 删除文件。
     * 若路径不存在则静默跳过。
     */
    async deleteFile(relativePath) {
        const absPath = this.resolve(relativePath);
        try {
            await fs.unlink(absPath);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
    }
    /** 获取文件的 mtime（毫秒），不存在返回 null */
    async getMtime(relativePath) {
        const absPath = this.resolve(relativePath);
        try {
            const stat = await fs.stat(absPath);
            return stat.mtimeMs;
        }
        catch {
            return null;
        }
    }
    /**
     * 重命名文件或目录（原子移动操作，源和目标必须在同一文件系统）。
     * 若目标已存在则会被覆盖（平台行为）。
     * 自动创建目标路径的父目录。
     */
    async rename(fromRelPath, toRelPath) {
        const fromAbs = this.resolve(fromRelPath);
        const toAbs = this.resolve(toRelPath);
        await fs.mkdir(path.dirname(toAbs), { recursive: true });
        await fs.rename(fromAbs, toAbs);
    }
    /** 判断文件是否存在 */
    async exists(relativePath) {
        const absPath = this.resolve(relativePath);
        try {
            await fs.access(absPath);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * 将相对路径解析为绝对路径，并验证结果在 localRoot 内（防路径穿越）。
     * 若解析结果逃逸出 localRoot，抛出错误而非静默处理。
     */
    resolve(relativePath) {
        const safe = (0, pathSanitize_1.canonicalizeRelativeSyncPath)((0, pathSanitize_1.normalizeSeparator)(relativePath));
        const resolved = path.resolve(this.localRoot, safe);
        const rootWithSep = this.localRoot.endsWith(path.sep)
            ? this.localRoot
            : this.localRoot + path.sep;
        if (resolved !== this.localRoot && !resolved.startsWith(rootWithSep)) {
            throw new Error(`路径越界: "${relativePath}" 解析后超出 localRoot 范围`);
        }
        return resolved;
    }
}
exports.LocalFsAdapter = LocalFsAdapter;
//# sourceMappingURL=localFs.js.map
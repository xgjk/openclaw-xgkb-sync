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
const assert = __importStar(require("node:assert/strict"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const node_test_1 = require("node:test");
const downloadUrlRewrite_1 = require("./downloadUrlRewrite");
function tempRewriteFile(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-rewrite-'));
    const filePath = path.join(dir, 'download-url-rewrites.json');
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
}
(0, node_test_1.afterEach)(() => {
    (0, downloadUrlRewrite_1.resetDownloadUrlRewriteCache)();
});
(0, node_test_1.describe)('rewriteDownloadUrl', () => {
    (0, node_test_1.it)('命中 from origin 时替换域名并保留 path/query', () => {
        const filePath = tempRewriteFile(JSON.stringify([
            {
                from: 'https://new-minio-cluster.meditube.hk',
                to: 'https://hk-al-minio.mediportal.com.cn',
            },
        ]));
        const input = 'https://new-minio-cluster.meditube.hk/bucket/key.pdf?X-Amz-Signature=abc&X-Amz-Expires=3600';
        const out = (0, downloadUrlRewrite_1.rewriteDownloadUrl)(input, { filePath, now: 1_000 });
        assert.equal(out, 'https://hk-al-minio.mediportal.com.cn/bucket/key.pdf?X-Amz-Signature=abc&X-Amz-Expires=3600');
    });
    (0, node_test_1.it)('未命中时保持原 URL', () => {
        const filePath = tempRewriteFile(JSON.stringify([
            {
                from: 'https://new-minio-cluster.meditube.hk',
                to: 'https://hk-al-minio.mediportal.com.cn',
            },
        ]));
        const input = 'https://other.example.com/a?b=1';
        assert.equal((0, downloadUrlRewrite_1.rewriteDownloadUrl)(input, { filePath, now: 1_000 }), input);
    });
    (0, node_test_1.it)('文件不存在时负缓存：TTL 内不重复读盘', () => {
        const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-rewrite-miss-')), 'missing.json');
        const url = 'https://new-minio-cluster.meditube.hk/x';
        assert.equal((0, downloadUrlRewrite_1.rewriteDownloadUrl)(url, { filePath, now: 1_000, ttlMs: 60_000 }), url);
        assert.equal((0, downloadUrlRewrite_1.getDownloadUrlRewriteDiskReadCount)(), 0);
        assert.equal((0, downloadUrlRewrite_1.rewriteDownloadUrl)(url, { filePath, now: 30_000, ttlMs: 60_000 }), url);
        assert.equal((0, downloadUrlRewrite_1.getDownloadUrlRewriteDiskReadCount)(), 0);
    });
    (0, node_test_1.it)('TTL 内有配置时只读盘一次', () => {
        const filePath = tempRewriteFile(JSON.stringify([
            {
                from: 'https://new-minio-cluster.meditube.hk',
                to: 'https://hk-al-minio.mediportal.com.cn',
            },
        ]));
        const url = 'https://new-minio-cluster.meditube.hk/a';
        const expected = 'https://hk-al-minio.mediportal.com.cn/a';
        assert.equal((0, downloadUrlRewrite_1.rewriteDownloadUrl)(url, { filePath, now: 1_000, ttlMs: 60_000 }), expected);
        assert.equal((0, downloadUrlRewrite_1.getDownloadUrlRewriteDiskReadCount)(), 1);
        assert.equal((0, downloadUrlRewrite_1.rewriteDownloadUrl)(url, { filePath, now: 50_000, ttlMs: 60_000 }), expected);
        assert.equal((0, downloadUrlRewrite_1.getDownloadUrlRewriteDiskReadCount)(), 1);
    });
    (0, node_test_1.it)('TTL 到期且 mtime 变化后重新加载', () => {
        const filePath = tempRewriteFile(JSON.stringify([
            {
                from: 'https://new-minio-cluster.meditube.hk',
                to: 'https://hk-al-minio.mediportal.com.cn',
            },
        ]));
        const url = 'https://new-minio-cluster.meditube.hk/a';
        assert.equal((0, downloadUrlRewrite_1.rewriteDownloadUrl)(url, { filePath, now: 1_000, ttlMs: 1_000 }), 'https://hk-al-minio.mediportal.com.cn/a');
        assert.equal((0, downloadUrlRewrite_1.getDownloadUrlRewriteDiskReadCount)(), 1);
        // 确保 mtime 可区分（部分 FS 精度为秒）
        const cur = fs.statSync(filePath).mtimeMs;
        fs.utimesSync(filePath, new Date(cur + 2000), new Date(cur + 2000));
        fs.writeFileSync(filePath, JSON.stringify([
            {
                from: 'https://new-minio-cluster.meditube.hk',
                to: 'https://other-minio.example.com',
            },
        ]), 'utf-8');
        assert.equal((0, downloadUrlRewrite_1.rewriteDownloadUrl)(url, { filePath, now: 5_000, ttlMs: 1_000 }), 'https://other-minio.example.com/a');
        assert.equal((0, downloadUrlRewrite_1.getDownloadUrlRewriteDiskReadCount)(), 2);
    });
});
//# sourceMappingURL=downloadUrlRewrite.test.js.map
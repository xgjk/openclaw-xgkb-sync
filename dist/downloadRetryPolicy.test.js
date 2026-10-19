"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const downloadRetryPolicy_1 = require("./downloadRetryPolicy");
const constants_1 = require("./constants");
function remote(mtime = 1000) {
    return {
        path: 'a.html',
        name: 'a.html',
        mtime,
        remoteFileId: 'rid-1',
        remoteFolderId: 'folder',
    };
}
function record(overrides = {}) {
    return {
        mappingId: 'm1',
        localPath: 'a.html',
        remoteFileId: 'rid-1',
        remoteFolderId: 'folder',
        remoteMtime: 1000,
        syncStatus: 'failed',
        downloadFailCount: 0,
        ...overrides,
    };
}
(0, node_test_1.describe)('classifyDownloadFailure', () => {
    (0, node_test_1.it)('权限不足 / 排队 / 超时禁止全文兜底', () => {
        strict_1.default.equal((0, downloadRetryPolicy_1.classifyDownloadFailure)('API error 0: 权限不足').allowFullContentFallback, false);
        strict_1.default.equal((0, downloadRetryPolicy_1.classifyDownloadFailure)('API error 0: 权限不足').failClass, 'permission');
        const queue = (0, downloadRetryPolicy_1.classifyDownloadFailure)('高峰期下载排队等待中，剩余约 12 分钟');
        strict_1.default.equal(queue.failClass, 'queue');
        strict_1.default.equal(queue.allowFullContentFallback, false);
        strict_1.default.equal(queue.suggestedBackoffMs, 12 * 60_000);
        strict_1.default.equal((0, downloadRetryPolicy_1.classifyDownloadFailure)('请求超时(>30000ms)').failClass, 'timeout');
        strict_1.default.equal((0, downloadRetryPolicy_1.classifyDownloadFailure)('请求超时(>30000ms)').allowFullContentFallback, false);
    });
    (0, node_test_1.it)('硬拦截与超限立即分类', () => {
        strict_1.default.equal((0, downloadRetryPolicy_1.classifyDownloadFailure)('x ##HARD_BLOCK##').failClass, 'hard_block');
        strict_1.default.equal((0, downloadRetryPolicy_1.classifyDownloadFailure)('远端文件超过安全上限 10485760 bytes').failClass, 'size_limit');
    });
});
(0, node_test_1.describe)('nextDownloadFailureState / gateDownloadRetry', () => {
    (0, node_test_1.it)('累计到最大次数后放弃自动重试', () => {
        let failCount = 0;
        let abandoned = false;
        for (let i = 0; i < constants_1.MAX_DOWNLOAD_ATTEMPTS; i++) {
            const next = (0, downloadRetryPolicy_1.nextDownloadFailureState)({
                previousFailCount: failCount,
                errorMessage: '请求超时(>30000ms)',
                now: 1_000_000,
            });
            failCount = next.downloadFailCount;
            abandoned = next.abandoned;
        }
        strict_1.default.equal(failCount, constants_1.MAX_DOWNLOAD_ATTEMPTS);
        strict_1.default.equal(abandoned, true);
        strict_1.default.equal((0, downloadRetryPolicy_1.gateDownloadRetry)({
            record: record({ downloadFailCount: constants_1.MAX_DOWNLOAD_ATTEMPTS, remoteMtime: 1000 }),
            remote: remote(1000),
            now: 9_999_999,
        }), 'abandon');
    });
    (0, node_test_1.it)('退避未到期则 defer，到期可 proceed', () => {
        strict_1.default.equal((0, downloadRetryPolicy_1.gateDownloadRetry)({
            record: record({
                downloadFailCount: 2,
                downloadNextRetryAt: 2_000_000,
                remoteMtime: 1000,
            }),
            remote: remote(1000),
            now: 1_500_000,
        }), 'defer');
        strict_1.default.equal((0, downloadRetryPolicy_1.gateDownloadRetry)({
            record: record({
                downloadFailCount: 2,
                downloadNextRetryAt: 2_000_000,
                remoteMtime: 1000,
            }),
            remote: remote(1000),
            now: 2_000_001,
        }), 'proceed');
    });
    (0, node_test_1.it)('远端 mtime 推进后视为新版本，允许重新下载', () => {
        strict_1.default.equal((0, downloadRetryPolicy_1.gateDownloadRetry)({
            record: record({
                downloadFailCount: constants_1.MAX_DOWNLOAD_ATTEMPTS,
                remoteMtime: 1000,
            }),
            remote: remote(5000),
            now: 9_999_999,
        }), 'proceed');
    });
    (0, node_test_1.it)('size_limit 一次即放弃', () => {
        const next = (0, downloadRetryPolicy_1.nextDownloadFailureState)({
            previousFailCount: 0,
            errorMessage: '远端文件 999 bytes 超过安全上限 10 bytes',
        });
        strict_1.default.equal(next.abandoned, true);
        strict_1.default.equal(next.downloadFailCount, constants_1.MAX_DOWNLOAD_ATTEMPTS);
    });
});
//# sourceMappingURL=downloadRetryPolicy.test.js.map
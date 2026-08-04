"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_REQUESTS_PER_MINUTE_LIMIT = exports.MAX_RATE_LIMIT_BURST = exports.MAX_UPLOAD_CONCURRENCY = exports.MAX_DOWNLOAD_CONCURRENCY = exports.MAX_CONCURRENT_MAPPINGS_LIMIT = exports.DEFAULT_MAX_CONCURRENT_MAPPINGS = exports.DEFAULT_AUTO_UPGRADE_ENABLED = exports.CENTRAL_REPORT_MAX_BACKOFF_MS = exports.CENTRAL_EXECUTION_LOG_MAX_PENDING = exports.CENTRAL_EXECUTION_LOG_CONCURRENCY = exports.CENTRAL_REPORT_TIMEOUT_MS = exports.DEFAULT_CENTRAL_HEARTBEAT_INTERVAL_SEC = exports.DEFAULT_CENTRAL_MANAGER_URL = exports.DEFAULT_MANAGEMENT_HOST = exports.DEFAULT_MANAGEMENT_PORT = exports.DEFAULT_FULL_RECONCILE_INTERVAL_SEC = exports.DEFAULT_AUTO_SYNC_INTERVAL_SEC = exports.DEFAULT_SERVER_URL = exports.MAX_LOG_FILE_BYTES = exports.DEFAULT_LOG_BASE_NAME = exports.DEFAULT_LOG_DIR = exports.DEFAULT_DB_PATH = exports.RECOMMENDED_DOT_DIR_EXCLUDE_PATTERNS = exports.DEFAULT_SYNC_DOT_FILES = exports.DEFAULT_EXCLUDE_PATTERNS = exports.DEFAULT_FILE_PATTERNS = exports.MTIME_TOLERANCE_MS = exports.API_ERROR_MESSAGE_BODY_MAX = exports.API_ERROR_LOG_MAX_CHARS = exports.REQUEST_TIMEOUT_MS = exports.RETRY_BASE_DELAY_MS = exports.MAX_RETRIES = exports.CHANGES_SAFETY_WINDOW_MS = exports.STOP_DRAIN_TIMEOUT_MS = exports.STARTUP_JITTER_MAX_MS = exports.TRANSIENT_RESULT_CODES = exports.RATE_LIMIT_RESULT_CODES = exports.RATE_LIMIT_COOLDOWN_MS = exports.DEFAULT_RATE_LIMIT_BURST = exports.DEFAULT_MAX_REQUESTS_PER_MINUTE = exports.EXECUTE_BATCH_PAUSE_MS = exports.UPLOAD_CONCURRENCY = exports.DOWNLOAD_CONCURRENCY = exports.BATCH_GET_META_MAX = exports.BATCH_GET_CONTENT_MAX = exports.DEFAULT_RENAME_NAME_CONFLICT_STRATEGY = exports.DEFAULT_MOVE_NAME_CONFLICT_STRATEGY = exports.MOVE_FILE_CONFLICT = exports.UPDATE_FILE_NAME_CONFLICT = exports.API_PATHS = void 0;
exports.MASS_DELETE_LOCAL_DROP_RATIO = exports.MASS_DELETE_REMOTE_BLOCK_COUNT = exports.LOCAL_ROOT_GUARD_MIN_KNOWN_FILES = exports.API_SLOW_REQUEST_LOG_MS = exports.PERMANENT_ERROR_CIRCUIT_MAX_MS = exports.PERMANENT_ERROR_CIRCUIT_BASE_MS = exports.MAX_NATIVE_RECURSIVE_WATCH_ROOTS = exports.WATCH_PULL_IGNORE_TAIL_MS = exports.WATCH_AWAIT_WRITE_POLL_MS = exports.WATCH_AWAIT_WRITE_STABILITY_MS = exports.DEFAULT_WATCH_USE_POLLING = exports.DEFAULT_PUSH_DEBOUNCE_MS = exports.DEFAULT_WATCH_ENABLED = exports.FILE_INDEX_CONSUME_MAX_RETRIES = exports.FILE_INDEX_PUBLISH_MAX_RETRIES = exports.FILE_INDEX_NAME = exports.VERSION_REMARK = exports.MAX_FILE_SIZE_BYTES_LIMIT = exports.DEFAULT_MAX_FILE_SIZE_BYTES = exports.MAX_SYNC_ERROR_DETAILS = void 0;
exports.cleanContent = cleanContent;
exports.buildListDescendantFilesSuffix = buildListDescendantFilesSuffix;
exports.extractUniqueSuffix = extractUniqueSuffix;
exports.API_PATHS = {
    getChildFiles: 'document-database/file/getChildFiles',
    listDescendantFiles: 'document-database/file/listDescendantFiles',
    listChanges: 'document-database/file/listChanges',
    batchGetMeta: 'document-database/file/batchGetMeta',
    createFolder: 'document-database/file/createFolder',
    getDownloadInfo: 'document-database/file/getDownloadInfo',
    getFileContent: 'document-database/file/getFileContent',
    getFullFileContent: 'document-database/file/getFullFileContent',
    uploadContent: 'document-database/file/uploadContent',
    searchFile: 'document-database/file/searchFile',
    getLevel1Folders: 'document-database/file/getLevel1Folders',
    deleteFile: 'document-database/file/deleteFile',
    getVersionList: 'document-database/file/getVersionList',
    getPersonalProjectId: 'document-database/project/personal/getProjectId',
    getProjectList: 'document-database/project/list',
    /** 见《03-AI与纯文本高速通道》4.15，建议单次不超过 10 个文件 */
    batchGetContent: 'document-database/ai/batchGetContent',
    /** 文件/文件夹重命名（同目录内改名，不移动） */
    updateFileName: 'document-database/file/updateFileName',
    /** 文件/文件夹移动到其他目录（可同时改名） */
    moveFile: 'document-database/file/moveFile',
    // ==================== 分片上传 ====================
    /** 预检分片 MD5（支持秒传） */
    getSliceIdByMd5V2: 'document-database/file/getSliceIdByMd5V2',
    /** 注册已上传的分片 */
    uploadFileSliceV2: 'document-database/file/uploadFileSliceV2',
    /** 合并分片生成 resourceId */
    saveResource: 'document-database/file/saveResource',
    // ==================== 物理文件入库 ====================
    /** 通过父目录 ID 保存文件到项目（需已知 parentId） */
    saveFileByParentId: 'document-database/file/saveFileByParentId',
    /** 通过路径保存文件到项目（自动递归创建目录） */
    saveFileByPath: 'document-database/file/saveFileByPath',
    /** 上传新文件内容以更新文件版本 */
    updateFileVersion: 'document-database/file/updateFileVersion',
};
/**
 * updateFileName 名称冲突策略。
 * 冲突是指目标目录下已存在同名节点。
 */
exports.UPDATE_FILE_NAME_CONFLICT = {
    /** 自动追加后缀重命名（如 "file (1).md"），不报错 */
    RENAME: 0,
    /** 抛出异常，由调用方决策 */
    ERROR: 1,
};
/**
 * moveFile 名称冲突策略。
 * 冲突是指目标父目录下已存在同名节点。
 *
 * 注意：COVER 策略会导致 fileId 变更，调用方需处理 idMappings。
 */
exports.MOVE_FILE_CONFLICT = {
    /** 自动追加后缀重命名目标侧节点，不删除任何文件 */
    RENAME: 0,
    /** 覆盖目标：保留冲突文件的 fileId，将移动文件作为其新版本；fileId 随之变更 */
    COVER: 1,
    /** 抛出异常，由调用方决策 */
    ERROR: 2,
    /** 跳过该冲突项 */
    SKIP: 3,
};
/** moveFile 默认冲突策略：3=跳过（用户可在 mapping.moveNameConflictStrategy 覆盖） */
exports.DEFAULT_MOVE_NAME_CONFLICT_STRATEGY = exports.MOVE_FILE_CONFLICT.SKIP;
/** updateFileName 默认冲突策略：1=抛异常（KB 省略时亦为 1） */
exports.DEFAULT_RENAME_NAME_CONFLICT_STRATEGY = exports.UPDATE_FILE_NAME_CONFLICT.ERROR;
/** batchGetContent 单批最大文件数 */
exports.BATCH_GET_CONTENT_MAX = 10;
/** batchGetMeta 单批最大文件数 */
exports.BATCH_GET_META_MAX = 50;
/** 并发下载 OSS 文件的最大并发数（默认值，可被 config.downloadConcurrency 覆盖） */
exports.DOWNLOAD_CONCURRENCY = 5;
/** 并发上传文件的最大并发数（默认值，可被 config.uploadConcurrency 覆盖） */
exports.UPLOAD_CONCURRENCY = 3;
/** 每批执行完成后的间隔（毫秒），为限速器补充令牌、平滑突发 */
exports.EXECUTE_BATCH_PAUSE_MS = 300;
/** 默认每分钟最大 API 请求数（令牌桶稳态速率） */
exports.DEFAULT_MAX_REQUESTS_PER_MINUTE = 180;
/** 默认令牌桶突发容量 */
exports.DEFAULT_RATE_LIMIT_BURST = 8;
/** 收到 429 后限速器默认冷却时间（毫秒） */
exports.RATE_LIMIT_COOLDOWN_MS = 60_000;
/**
 * 知识库业务层限流错误码集合。
 * 收到这些 resultCode 时应视为可恢复的限流，触发限速器冷却后重试，而非永久错误。
 * 610012 = "请求太过频繁，请稍候再试！"（按 appKey 全局限流）
 */
exports.RATE_LIMIT_RESULT_CODES = new Set([610012]);
/** 业务层临时服务端错误码：HTTP 为 200 但 resultCode 表示服务端短暂失败，应退避重试 */
exports.TRANSIENT_RESULT_CODES = new Set([500]);
/** 启动时随机抖动最大值（毫秒），分散多实例同时启动导致的请求突刺 */
exports.STARTUP_JITTER_MAX_MS = 20_000;
/** stop()/reload 时等待进行中的 mapping 同步结束的最长时间（毫秒） */
exports.STOP_DRAIN_TIMEOUT_MS = 5 * 60_000;
/** listChanges 安全回拨窗口（毫秒），避免时钟偏差漏事件 */
exports.CHANGES_SAFETY_WINDOW_MS = 5_000;
/** HTTP 请求最大重试次数 */
exports.MAX_RETRIES = 3;
/** 指数退避基础延迟（毫秒） */
exports.RETRY_BASE_DELAY_MS = 1_000;
/** HTTP 请求超时（毫秒），防止服务端挂起永久阻塞 */
exports.REQUEST_TIMEOUT_MS = 30_000;
/** API 失败时控制台诊断日志中单段文本最大长度 */
exports.API_ERROR_LOG_MAX_CHARS = 4096;
/** API 失败时写入 ApiResult.error / SQLite lastError 的响应摘要最大长度 */
exports.API_ERROR_MESSAGE_BODY_MAX = 800;
/** mtime 比较容差（毫秒），消除精度误差 */
exports.MTIME_TOLERANCE_MS = 1_000;
/** 默认同步文件匹配模式 */
exports.DEFAULT_FILE_PATTERNS = ['**/*.md'];
/** 默认排除匹配模式 */
exports.DEFAULT_EXCLUDE_PATTERNS = ['**/_conflict_*', '**/.tmp/**'];
/**
 * 是否同步以 `.` 开头的路径段（点文件 / 点目录）。
 * false：由 syncDotFiles 机制排除；true 时仅由 filePatterns / excludePatterns 决定。
 */
exports.DEFAULT_SYNC_DOT_FILES = false;
/**
 * syncDotFiles=true 时建议在 excludePatterns 中追加的常见点目录（文档参考，非默认注入）。
 * 避免 `.git`、`.obsidian` 等工具目录被同步到知识库。
 */
exports.RECOMMENDED_DOT_DIR_EXCLUDE_PATTERNS = [
    '**/.git/**',
    '**/.obsidian/**',
    '**/.vscode/**',
    '**/.idea/**',
    '**/.cache/**',
    '**/.tmp/**',
];
/** 默认状态库文件路径 */
exports.DEFAULT_DB_PATH = './openclaw-sync-state.db';
/** 默认日志目录（相对进程工作目录） */
exports.DEFAULT_LOG_DIR = 'logs';
/** 默认日志文件名前缀（实际为 `{baseName}-YYYY-MM-DD.log`） */
exports.DEFAULT_LOG_BASE_NAME = 'openclaw-sync';
/** 单个日志文件大小上限（字节），超出后同日递增段号 `.1`、`.2`… */
exports.MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
/** 默认知识库 Open API 根地址（生产环境） */
exports.DEFAULT_SERVER_URL = 'https://sg-al-cwork-web.mediportal.com.cn/open-api/';
/** 默认自动同步间隔（秒） */
exports.DEFAULT_AUTO_SYNC_INTERVAL_SEC = 180;
/** 默认强制全量对账间隔（秒），用于修复 listChanges 或本地状态库漏记录 */
exports.DEFAULT_FULL_RECONCILE_INTERVAL_SEC = 3600;
/** 默认 HTTP 管理 API 端口 */
exports.DEFAULT_MANAGEMENT_PORT = 9090;
/** 默认 HTTP 管理 API 监听地址 */
exports.DEFAULT_MANAGEMENT_HOST = '0.0.0.0';
/** 默认 sync-manage 集中管理地址（测试环境）；留空字符串可关闭上报 */
exports.DEFAULT_CENTRAL_MANAGER_URL = 'https://cwork-api-test.xgjktech.com.cn/sync-manage';
/** sync-manage 心跳默认间隔（秒） */
exports.DEFAULT_CENTRAL_HEARTBEAT_INTERVAL_SEC = 45;
/** sync-manage 单次 HTTP 上报超时，避免对端停服/半开连接永久占用内存。 */
exports.CENTRAL_REPORT_TIMEOUT_MS = 30_000;
/** execution-log 最大并发请求数；其余按 mappingId 合并到有界待发送队列。 */
exports.CENTRAL_EXECUTION_LOG_CONCURRENCY = 2;
/** execution-log 队列最大 mapping 数；同一 mapping 只保留最新一条。 */
exports.CENTRAL_EXECUTION_LOG_MAX_PENDING = 200;
/** 中心连续失败后的最大退避时间，防止 connection-refused 时高频重试。 */
exports.CENTRAL_REPORT_MAX_BACKOFF_MS = 60_000;
/** 发现 latestAppVersion 更新时默认自动升级（显式 false 可关闭） */
exports.DEFAULT_AUTO_UPGRADE_ENABLED = true;
/** 默认最大并发 mapping 数 */
exports.DEFAULT_MAX_CONCURRENT_MAPPINGS = 2;
/** 资源安全硬上限：防止错误配置让所有 mapping / 文件同时占用内存。 */
exports.MAX_CONCURRENT_MAPPINGS_LIMIT = 10;
exports.MAX_DOWNLOAD_CONCURRENCY = 20;
exports.MAX_UPLOAD_CONCURRENCY = 10;
exports.MAX_RATE_LIMIT_BURST = 1_000;
exports.MAX_REQUESTS_PER_MINUTE_LIMIT = 60_000;
/** 单轮仅保留有限数量错误明细；失败总数仍由 stats.failed 完整记录。 */
exports.MAX_SYNC_ERROR_DETAILS = 100;
/** 单文件默认内存安全上限（文本知识库文件）；可通过配置降低或提高。 */
exports.DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
exports.MAX_FILE_SIZE_BYTES_LIMIT = 1024 * 1024 * 1024;
/** 版本备注 */
exports.VERSION_REMARK = 'OpenClaw Sync Agent';
/** 映射索引文件名（mapping 根目录，全量 path→fileId 表） */
exports.FILE_INDEX_NAME = '.openclaw-sync-map.json';
/** publish 索引 uploadContent 最大重试次数（与 MAX_RETRIES 一致） */
exports.FILE_INDEX_PUBLISH_MAX_RETRIES = exports.MAX_RETRIES;
/** consume 索引下载最大重试次数 */
exports.FILE_INDEX_CONSUME_MAX_RETRIES = 2;
/** 本地文件监听默认开启（push/bidirectional） */
exports.DEFAULT_WATCH_ENABLED = true;
/** watch 触发 sync 前的 debounce（毫秒） */
exports.DEFAULT_PUSH_DEBOUNCE_MS = 1500;
/** watch 不可靠环境（NFS/Docker 卷）是否改用轮询 */
exports.DEFAULT_WATCH_USE_POLLING = false;
/** awaitWriteFinish：文件大小稳定多久视为写入完成（毫秒） */
exports.WATCH_AWAIT_WRITE_STABILITY_MS = 300;
/** awaitWriteFinish 轮询间隔（毫秒） */
exports.WATCH_AWAIT_WRITE_POLL_MS = 100;
/** pull 写入结束后 ignoreSet 额外保留时间（毫秒），防止 resume 后 chokidar 迟到的 echo */
exports.WATCH_PULL_IGNORE_TAIL_MS = 200;
/** macOS 原生递归 watcher 的根目录硬上限；超出部分依赖定时同步兜底。 */
exports.MAX_NATIVE_RECURSIVE_WATCH_ROOTS = 256;
/** 永久远端错误首次熔断 30 分钟，重复探测失败后指数退避，最长 24 小时。 */
exports.PERMANENT_ERROR_CIRCUIT_BASE_MS = 30 * 60_000;
exports.PERMANENT_ERROR_CIRCUIT_MAX_MS = 24 * 60 * 60_000;
/** 成功 API 仅记录慢请求；普通成功请求不再逐条打印参数和响应。 */
exports.API_SLOW_REQUEST_LOG_MS = 5_000;
/** 状态库至少有多少条文件记录时，才启用「本地骤降」远端删除保护 */
exports.LOCAL_ROOT_GUARD_MIN_KNOWN_FILES = 20;
/** 单轮计划中 delete-remote 达到此数量且本地骤降时，触发保护并改为拉取 */
exports.MASS_DELETE_REMOTE_BLOCK_COUNT = 10;
/** 本地文件数相对状态库记录降幅超过此比例时，视为工作区异常（与 BLOCK_COUNT 联用） */
exports.MASS_DELETE_LOCAL_DROP_RATIO = 0.8;
/**
 * 清理知识库返回的正文（去除分页页脚等）。
 * raw 为 null/undefined 时返回空字符串。
 */
function cleanContent(raw) {
    if (raw == null)
        return '';
    return raw.replace(/\n*Page \d+ of \d+\s*$/, '').trimEnd() + '\n';
}
/** filePatterns 末尾 `*.ext` 捕获组，用于推断 listDescendantFiles 的 suffix 参数 */
const FILE_PATTERN_EXT_SUFFIX_RE = /\*\.([a-zA-Z0-9]+)$/;
/**
 * 判断 glob 是否表示「不限扩展名」（需传 suffix=*，避免不传时 KB 默认 md）。
 */
function isCatchAllFilePattern(pattern) {
    if (pattern === '**/*' || pattern === '*' || pattern === '**/**')
        return true;
    // brace / negation 等 micromatch 复杂语法无法可靠推断扩展名
    if (/[{[\]!]/.test(pattern))
        return true;
    // 如 `**/notes/*`：目录下所有文件，非单一 ext
    if (/\/\*[^.]*$/.test(pattern) && !FILE_PATTERN_EXT_SUFFIX_RE.test(pattern))
        return true;
    return false;
}
/**
 * 从 filePatterns 构造 listDescendantFiles 的 suffix 参数。
 *
 * KB 约定（待 KB 侧上线）：
 * - 不传：默认仅 `md`（同步端应始终显式传 suffix，避免踩默认）
 * - 单值：如 `md`
 * - 多值：逗号分隔，如 `md,png,pdf`
 * - `*`：不过滤类型，返回全部（客户端仍用 filePatterns 二次过滤）
 *
 * @example
 *   buildListDescendantFilesSuffix(['**\/*.md']) => 'md'
 *   buildListDescendantFilesSuffix(['**\/*.md', '**\/*.png']) => 'md,png'
 *   buildListDescendantFilesSuffix(['**\/*']) => '*'
 */
function buildListDescendantFilesSuffix(patterns) {
    if (patterns.length === 0)
        return '*';
    const suffixes = new Set();
    for (const p of patterns) {
        if (isCatchAllFilePattern(p))
            return '*';
        const m = p.match(FILE_PATTERN_EXT_SUFFIX_RE);
        if (!m)
            return '*';
        suffixes.add(m[1].toLowerCase());
    }
    return [...suffixes].sort().join(',');
}
/** @deprecated 使用 buildListDescendantFilesSuffix */
function extractUniqueSuffix(patterns) {
    const suffix = buildListDescendantFilesSuffix(patterns);
    if (suffix === '*')
        return undefined;
    const parts = suffix.split(',');
    return parts.length === 1 ? parts[0] : undefined;
}
//# sourceMappingURL=constants.js.map
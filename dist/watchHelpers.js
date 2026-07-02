"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.needsPush = needsPush;
exports.needsPull = needsPull;
exports.resolveMappingSyncDirection = resolveMappingSyncDirection;
exports.resolveWatchEnabled = resolveWatchEnabled;
exports.resolvePushDebounceMs = resolvePushDebounceMs;
exports.resolveWatchUsePolling = resolveWatchUsePolling;
exports.formatSyncTriggerReason = formatSyncTriggerReason;
const constants_1 = require("./constants");
function needsPush(mapping, globalDirection) {
    const dir = resolveMappingSyncDirection(mapping, globalDirection);
    return dir === 'push' || dir === 'bidirectional';
}
function needsPull(mapping, globalDirection) {
    const dir = resolveMappingSyncDirection(mapping, globalDirection);
    return dir === 'pull' || dir === 'bidirectional';
}
/** mapping 实际生效的同步方向（未单独配置时继承全局） */
function resolveMappingSyncDirection(mapping, globalDirection) {
    return mapping.syncDirection ?? globalDirection;
}
function resolveWatchEnabled(mapping, config) {
    if (!needsPush(mapping, config.syncDirection))
        return false;
    if (mapping.watchEnabled !== undefined)
        return mapping.watchEnabled;
    if (config.watchEnabled !== undefined)
        return config.watchEnabled;
    return constants_1.DEFAULT_WATCH_ENABLED;
}
function resolvePushDebounceMs(mapping, config) {
    const ms = mapping.pushDebounceMs ?? config.pushDebounceMs ?? constants_1.DEFAULT_PUSH_DEBOUNCE_MS;
    return Math.max(100, ms);
}
function resolveWatchUsePolling(mapping, config) {
    if (mapping.watchUsePolling !== undefined)
        return mapping.watchUsePolling;
    if (config.watchUsePolling !== undefined)
        return config.watchUsePolling;
    return constants_1.DEFAULT_WATCH_USE_POLLING;
}
function formatSyncTriggerReason(reason) {
    switch (reason) {
        case 'watch':
            return 'watch';
        case 'timer':
            return 'timer';
        case 'startup':
            return 'startup';
        case 'manual':
            return 'manual';
    }
}
//# sourceMappingURL=watchHelpers.js.map
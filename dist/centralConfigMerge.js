"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeCentralConfigPatch = mergeCentralConfigPatch;
exports.applyCentralConfigPatch = applyCentralConfigPatch;
exports.buildReportedConfig = buildReportedConfig;
const config_1 = require("./config");
const watchHelpers_1 = require("./watchHelpers");
const MAPPING_IDENTITY_FIELDS = [
    'localRoot',
    'remoteRootFolderPath',
    'remoteRootFileId',
    'projectId',
    'appKey',
];
/**
 * 将 sync-manage 下发的 config patch 合并进本地配置（不整文件覆盖）。
 * 白名单由中心维护；节点对 patch 中出现的字段做 merge。
 */
function mergeCentralConfigPatch(local, patch, configVersion) {
    const identityChangedMappingIds = [];
    const raw = {
        ...(0, config_1.configToRaw)(local),
        localConfigVersion: configVersion,
    };
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'mappings')
            continue;
        if (value !== undefined)
            raw[key] = value;
    }
    if (Array.isArray(patch.mappings)) {
        const existingMappings = Array.isArray(raw.mappings)
            ? raw.mappings
            : local.mappings;
        const byId = new Map(existingMappings.map((m) => [m.mappingId, m]));
        for (let i = 0; i < patch.mappings.length; i++) {
            const item = patch.mappings[i];
            if (typeof item !== 'object' || item === null || Array.isArray(item))
                continue;
            const patchObj = item;
            const mappingId = typeof patchObj.mappingId === 'string' ? patchObj.mappingId.trim() : '';
            if (!mappingId)
                continue;
            const existing = byId.get(mappingId);
            const merged = existing
                ? { ...existing, ...patchObj, mappingId }
                : { ...patchObj, mappingId };
            const validated = (0, config_1.validateMapping)(merged, i, '<central-config>');
            if (existing) {
                for (const field of MAPPING_IDENTITY_FIELDS) {
                    if (JSON.stringify(existing[field]) !== JSON.stringify(validated[field])) {
                        identityChangedMappingIds.push(mappingId);
                        break;
                    }
                }
            }
            byId.set(mappingId, validated);
        }
        raw.mappings = [...byId.values()];
    }
    const config = (0, config_1.parseSyncConfig)(raw, '<central-config>');
    return {
        config,
        identityChangedMappingIds: [...new Set(identityChangedMappingIds)],
    };
}
/** 合并、持久化，并返回合并后的配置（不触发 reload，由调用方负责） */
function applyCentralConfigPatch(opts) {
    const { config, identityChangedMappingIds } = mergeCentralConfigPatch(opts.local, opts.patch, opts.configVersion);
    for (const mappingId of identityChangedMappingIds) {
        opts.resetMappingState(mappingId);
        console.log(`[CentralConfig] mapping "${mappingId}" 身份字段已变更，已重置同步状态`);
    }
    (0, config_1.writeConfigFile)(opts.configPath, (0, config_1.configToRaw)(config));
    console.log(`[CentralConfig] 已写入 config.json，localConfigVersion=${opts.configVersion}`);
    return config;
}
/** 心跳上报用的 reportedConfig（完整 config.json 内容，含 appKey 明文） */
function buildReportedConfig(config) {
    const raw = (0, config_1.configToRaw)(config);
    const globalDir = config.syncDirection;
    if (Array.isArray(raw.mappings)) {
        raw.mappings = raw.mappings.map((m) => ({
            ...m,
            syncDirection: (0, watchHelpers_1.resolveMappingSyncDirection)(m, globalDir),
        }));
    }
    return raw;
}
//# sourceMappingURL=centralConfigMerge.js.map
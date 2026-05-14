import type { SyncConfig, SyncMapping } from './types';
/** 与 HTTP 400 响应中 `errorCode` 一致，供自动化解析 */
export declare const ERROR_CODE_MAPPING_APPKEY_REQUIRED: "MAPPING_APPKEY_REQUIRED_WHEN_NO_GLOBAL_APPKEY";
/**
 * 解析「本条 mapping 调用知识库 API」时实际使用的 appKey：
 * mapping 级非空优先，否则使用 config 根级全局 appKey。
 */
export declare function resolveEffectiveAppKey(config: SyncConfig, mapping: SyncMapping): string;
/**
 * 校验保存后的 mapping 是否具备可用的 API 密钥。
 * 规则：若根级全局 `appKey` 未配置（缺失、空串或仅空白），则本条 mapping 必须自带非空 `appKey`。
 *
 * @returns `null` 表示通过；否则为明确错误信息（可直接作为 HTTP 400 的 `error` 字段）
 */
export declare function getMappingCredentialsViolation(config: SyncConfig, mapping: SyncMapping): {
    error: string;
    errorCode: typeof ERROR_CODE_MAPPING_APPKEY_REQUIRED;
} | null;
//# sourceMappingURL=managementApiCredentials.d.ts.map
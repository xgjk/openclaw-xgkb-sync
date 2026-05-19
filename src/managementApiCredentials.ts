import type { SyncConfig, SyncMapping } from './types';

/** 与 HTTP 400 响应中 `errorCode` 一致，供自动化解析 */
export const ERROR_CODE_MAPPING_APPKEY_REQUIRED = 'MAPPING_APPKEY_REQUIRED_WHEN_NO_GLOBAL_APPKEY' as const;

/**
 * 解析「本条 mapping 调用知识库 API」时实际使用的 appKey：
 * mapping 级非空优先，否则使用 config 根级全局 appKey。
 */
export function resolveEffectiveAppKey(config: SyncConfig, mapping: SyncMapping): string {
  const fromMapping = mapping.appKey?.trim() ?? '';
  if (fromMapping.length > 0) return fromMapping;
  return config.appKey?.trim() ?? '';
}

/**
 * 校验保存后的 mapping 是否具备可用的 API 密钥。
 * 规则：若根级全局 `appKey` 未配置（缺失、空串或仅空白），则本条 mapping 必须自带非空 `appKey`。
 *
 * @returns `null` 表示通过；否则为明确错误信息（可直接作为 HTTP 400 的 `error` 字段）
 */
export function getMappingCredentialsViolation(
  config: SyncConfig,
  mapping: SyncMapping,
): { error: string; errorCode: typeof ERROR_CODE_MAPPING_APPKEY_REQUIRED } | null {
  if (resolveEffectiveAppKey(config, mapping).length > 0) return null;

  return {
    error:
      '无法保存 mapping：根级全局 appKey 未设置或为空（未注册全局密钥），且本条 mapping 也未提供非空的 appKey。' +
      '请二选一：① 在 config.json 根级配置非空字符串 appKey；' +
      '② 在本次 HTTP 请求体 JSON 中为该条 mapping 设置非空字符串字段 appKey。' +
      '（适用：POST /mappings 新建、PUT /mappings/:id upsert 后合并结果。）',
    errorCode: ERROR_CODE_MAPPING_APPKEY_REQUIRED,
  };
}

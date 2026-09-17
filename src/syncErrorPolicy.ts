import type { SyncOp } from './types';

export type PermanentSyncFailureCategory = 'authentication' | 'permission' | 'validation';

export interface PermanentSyncFailure {
  category: PermanentSyncFailureCategory;
  message: string;
}

const AUTHENTICATION_PATTERNS = [
  /(?:HTTP|status|code|API\s+error)\s*[:=#]?\s*401\b/i,
  /unauthori[sz]ed/i,
  /unauthenticated/i,
  /invalid\s+(?:app\s*key|token|credential)/i,
  /(?:app\s*key|token|credential).*(?:invalid|expired)/i,
  /认证失败|鉴权失败|登录失效|未登录|身份验证失败/,
];

const PERMISSION_PATTERNS = [
  /(?:HTTP|status|code|API\s+error)\s*[:=#]?\s*403\b/i,
  /forbidden/i,
  /权限不足|没有权限|无权限|无权访问|禁止访问/,
];

const REMOTE_QUALIFIED_PERMISSION_PATTERN =
  /(?:API\s+error|HTTP|resultCode|response|远端).*(?:access\s+denied|permission\s+denied|not\s+permitted)/i;

const VALIDATION_PATTERNS = [
  /HTTP\s+400\b/i,
  /bad\s+request/i,
  /invalid\s+(?:argument|parameter|param)\b/i,
  /missing\s+(?:required\s+)?(?:argument|parameter|param)\b/i,
  /参数错误|参数无效|参数不能为空|缺少.{0,12}参数|必填.{0,12}(?:缺失|为空)/,
];

/**
 * 只识别明确不会靠立即重试恢复的远端拒绝。
 * 404、文件不存在、冲突等仍按普通文件错误处理，避免误熔断整个 mapping。
 */
export function classifyPermanentSyncFailure(message: string): PermanentSyncFailure | null {
  const text = String(message ?? '').trim();
  if (!text) return null;

  if (AUTHENTICATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return { category: 'authentication', message: text };
  }
  if (
    PERMISSION_PATTERNS.some((pattern) => pattern.test(text)) ||
    REMOTE_QUALIFIED_PERMISSION_PATTERN.test(text)
  ) {
    return { category: 'permission', message: text };
  }
  if (VALIDATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return { category: 'validation', message: text };
  }
  return null;
}

export function permanentCircuitDelayMs(
  failureLevel: number,
  baseMs: number,
  maxMs: number,
): number {
  const safeLevel = Math.max(1, Math.floor(failureLevel));
  return Math.min(maxMs, baseMs * Math.pow(2, safeLevel - 1));
}

const REMOTE_WRITE_OPS = new Set<SyncOp>([
  'upload-new',
  'upload-update',
  'delete-remote',
  'rename-remote',
  'move-remote',
]);

/** 只有明确发生在远端写操作上的权限拒绝才允许安全降级为只读。 */
export function isRemoteWritePermissionFailure(
  failure: PermanentSyncFailure | null | undefined,
  op?: SyncOp | null,
): boolean {
  return failure?.category === 'permission' && !!op && REMOTE_WRITE_OPS.has(op);
}

/**
 * 兼容升级前没有记录 op 的熔断状态。只有包含明确写 API/操作名的权限错误才迁移，
 * 避免把读取或初始化权限错误错误地降级成可继续拉取。
 */
export function isLegacyRemoteWritePermissionReason(message: string): boolean {
  const failure = classifyPermanentSyncFailure(message);
  if (failure?.category !== 'permission') return false;
  return /saveFileByPath|saveFileByParentId|updateFileVersion|updateFileName|moveFile|deleteFile|upload-(?:new|update)/i.test(
    message,
  );
}

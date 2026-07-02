import * as fs from 'fs';
import * as path from 'path';
import {
  LOCAL_ROOT_GUARD_MIN_KNOWN_FILES,
  MASS_DELETE_LOCAL_DROP_RATIO,
  MASS_DELETE_REMOTE_BLOCK_COUNT,
} from './constants';
import { MappingState } from './types';

export type LocalRootFailureReason = 'missing' | 'not_directory' | 'not_readable' | 'empty_path';

export type LocalRootCheckResult =
  | { ok: true; path: string }
  | { ok: false; reason: LocalRootFailureReason; path: string; detail: string };

export interface RemoteDeleteGuardInput {
  localFileCount: number;
  knownRecordCount: number;
  plannedDeleteRemoteCount: number;
}

export interface RemoteDeleteGuardResult {
  active: boolean;
  reason: string;
  recoveryOp: 'download-new';
}

/**
 * 同步开始前检查 localRoot 是否可用于扫描。
 * 不自动 mkdir——目录缺失视为异常，避免在空目录上继续对账删远端。
 */
export function inspectLocalRoot(localRoot: string): LocalRootCheckResult {
  const trimmed = localRoot.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: 'empty_path',
      path: trimmed,
      detail: 'localRoot 不能为空',
    };
  }

  const resolved = path.resolve(trimmed);

  if (!fs.existsSync(resolved)) {
    return {
      ok: false,
      reason: 'missing',
      path: resolved,
      detail: `localRoot 不存在: ${resolved}`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: 'not_readable',
      path: resolved,
      detail: `无法访问 localRoot "${resolved}": ${msg}`,
    };
  }

  if (!stat.isDirectory()) {
    return {
      ok: false,
      reason: 'not_directory',
      path: resolved,
      detail: `localRoot 不是目录: ${resolved}`,
    };
  }

  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: 'not_readable',
      path: resolved,
      detail: `localRoot 不可读 "${resolved}": ${msg}`,
    };
  }

  return { ok: true, path: resolved };
}

/**
 * 本地工作区是否相对历史同步状态「异常偏空」。
 * 典型场景：工作空间迁移、挂载丢失、路径配错导致目录被清空。
 */
export function isLocalWorkspaceAnomaly(
  localFileCount: number,
  knownRecordCount: number,
): boolean {
  if (knownRecordCount < LOCAL_ROOT_GUARD_MIN_KNOWN_FILES) return false;
  if (localFileCount === 0) return true;
  const dropRatio = (knownRecordCount - localFileCount) / knownRecordCount;
  return dropRatio >= MASS_DELETE_LOCAL_DROP_RATIO;
}

/**
 * 在本地工作区异常偏空时，阻断批量 delete-remote，并改为从远端重新拉取。
 */
export function evaluateRemoteDeleteGuard(
  input: RemoteDeleteGuardInput,
): RemoteDeleteGuardResult {
  const inactive: RemoteDeleteGuardResult = {
    active: false,
    reason: '',
    recoveryOp: 'download-new',
  };

  const { localFileCount, knownRecordCount, plannedDeleteRemoteCount } = input;

  if (plannedDeleteRemoteCount === 0) return inactive;
  if (!isLocalWorkspaceAnomaly(localFileCount, knownRecordCount)) return inactive;

  // 本地完全为空：任意 delete-remote 均视为误删风险
  if (localFileCount > 0 && plannedDeleteRemoteCount < MASS_DELETE_REMOTE_BLOCK_COUNT) {
    return inactive;
  }

  const reason =
    localFileCount === 0
      ? `本地目录为空（0 个文件），但状态库仍有 ${knownRecordCount} 条记录；` +
        `已阻断 ${plannedDeleteRemoteCount} 项远端删除，改为从远端重新拉取`
      : `本地文件数骤降（${localFileCount}/${knownRecordCount}，降幅 ${Math.round(
          ((knownRecordCount - localFileCount) / knownRecordCount) * 100,
        )}%）；` +
        `已阻断 ${plannedDeleteRemoteCount} 项远端删除，改为从远端重新拉取`;

  return { active: true, reason, recoveryOp: 'download-new' };
}

/**
 * mapping 是否曾有过有效同步历史（用于区分「新建尚未同步」与「运行中根目录被删」）。
 */
export function hasMappingSyncHistory(
  mappingState: MappingState | undefined,
  fileRecordCount: number,
): boolean {
  if (fileRecordCount > 0) return true;
  if (!mappingState) return false;
  if (mappingState.lastSuccessAt) return true;
  if (mappingState.lastSyncSince) return true;
  if (mappingState.resolvedRootFileId) return true;
  return false;
}

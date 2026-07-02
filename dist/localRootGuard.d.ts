import { MappingState } from './types';
export type LocalRootFailureReason = 'missing' | 'not_directory' | 'not_readable' | 'empty_path';
export type LocalRootCheckResult = {
    ok: true;
    path: string;
} | {
    ok: false;
    reason: LocalRootFailureReason;
    path: string;
    detail: string;
};
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
export declare function inspectLocalRoot(localRoot: string): LocalRootCheckResult;
/**
 * 本地工作区是否相对历史同步状态「异常偏空」。
 * 典型场景：工作空间迁移、挂载丢失、路径配错导致目录被清空。
 */
export declare function isLocalWorkspaceAnomaly(localFileCount: number, knownRecordCount: number): boolean;
/**
 * 在本地工作区异常偏空时，阻断批量 delete-remote，并改为从远端重新拉取。
 */
export declare function evaluateRemoteDeleteGuard(input: RemoteDeleteGuardInput): RemoteDeleteGuardResult;
/**
 * mapping 是否曾有过有效同步历史（用于区分「新建尚未同步」与「运行中根目录被删」）。
 */
export declare function hasMappingSyncHistory(mappingState: MappingState | undefined, fileRecordCount: number): boolean;
//# sourceMappingURL=localRootGuard.d.ts.map
import type { SyncPlan } from './types';

export interface MassSyncProtectionInput {
  enabled: boolean;
  uploadPlans: SyncPlan[];
  downloadPlans: SyncPlan[];
  maxUploads: number;
  maxDownloads: number;
  localFileCount: number;
  remoteFileCount: number;
  knownFileCount: number;
}

export interface MassSyncProtectionTrip {
  uploadCount: number;
  downloadCount: number;
  maxUploads: number;
  maxDownloads: number;
  reason: string;
  samplePaths: string[];
}

const MAX_SAFETY_PATH_SAMPLES = 20;

/**
 * 在任何批量上传/下载发生前执行的纯判断。
 * 阈值表示“允许的最大数量”，因此只有严格超过时才熔断。
 */
export function evaluateMassSyncProtection(
  input: MassSyncProtectionInput,
): MassSyncProtectionTrip | null {
  if (!input.enabled) return null;

  const uploadCount = input.uploadPlans.length;
  const downloadCount = input.downloadPlans.length;
  const uploadExceeded = uploadCount > input.maxUploads;
  const downloadExceeded = downloadCount > input.maxDownloads;
  if (!uploadExceeded && !downloadExceeded) return null;

  const directions: string[] = [];
  if (uploadExceeded) directions.push(`上传 ${uploadCount} > ${input.maxUploads}`);
  if (downloadExceeded) directions.push(`下载 ${downloadCount} > ${input.maxDownloads}`);

  const samplePaths = [
    ...(uploadExceeded ? input.uploadPlans : []),
    ...(downloadExceeded ? input.downloadPlans : []),
  ]
    .slice(0, MAX_SAFETY_PATH_SAMPLES)
    .map((plan) => `${plan.op}:${plan.path}`);

  return {
    uploadCount,
    downloadCount,
    maxUploads: input.maxUploads,
    maxDownloads: input.maxDownloads,
    samplePaths,
    reason:
      `大批量同步保护触发（${directions.join('，')}；` +
      `本地=${input.localFileCount} 远端=${input.remoteFileCount} 历史=${input.knownFileCount}）。` +
      `为避免异常目录风暴扩散，本轮未执行上传/下载，该 mapping 将被自动禁用。` +
      `确认文件变化符合预期后，请调整排除规则或阈值，再重新启用 mapping。`,
  };
}

export class MassSyncProtectionError extends Error {
  readonly trip: MassSyncProtectionTrip;

  constructor(trip: MassSyncProtectionTrip) {
    super(trip.reason);
    this.name = 'MassSyncProtectionError';
    this.trip = trip;
  }
}

export function isMassSyncProtectionError(value: unknown): value is MassSyncProtectionError {
  return value instanceof MassSyncProtectionError;
}

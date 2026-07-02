import {
  DEFAULT_PUSH_DEBOUNCE_MS,
  DEFAULT_WATCH_ENABLED,
  DEFAULT_WATCH_USE_POLLING,
} from './constants';
import { SyncConfig, SyncMapping, SyncTriggerReason } from './types';

export function needsPush(
  mapping: SyncMapping,
  globalDirection: SyncConfig['syncDirection'],
): boolean {
  const dir = resolveMappingSyncDirection(mapping, globalDirection);
  return dir === 'push' || dir === 'bidirectional';
}

export function needsPull(
  mapping: SyncMapping,
  globalDirection: SyncConfig['syncDirection'],
): boolean {
  const dir = resolveMappingSyncDirection(mapping, globalDirection);
  return dir === 'pull' || dir === 'bidirectional';
}

/** mapping 实际生效的同步方向（未单独配置时继承全局） */
export function resolveMappingSyncDirection(
  mapping: SyncMapping,
  globalDirection: SyncConfig['syncDirection'],
): SyncConfig['syncDirection'] {
  return mapping.syncDirection ?? globalDirection;
}

export function resolveWatchEnabled(mapping: SyncMapping, config: SyncConfig): boolean {
  if (!needsPush(mapping, config.syncDirection)) return false;
  if (mapping.watchEnabled !== undefined) return mapping.watchEnabled;
  if (config.watchEnabled !== undefined) return config.watchEnabled;
  return DEFAULT_WATCH_ENABLED;
}

export function resolvePushDebounceMs(mapping: SyncMapping, config: SyncConfig): number {
  const ms = mapping.pushDebounceMs ?? config.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS;
  return Math.max(100, ms);
}

export function resolveWatchUsePolling(mapping: SyncMapping, config: SyncConfig): boolean {
  if (mapping.watchUsePolling !== undefined) return mapping.watchUsePolling;
  if (config.watchUsePolling !== undefined) return config.watchUsePolling;
  return DEFAULT_WATCH_USE_POLLING;
}

export function formatSyncTriggerReason(reason: SyncTriggerReason): string {
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

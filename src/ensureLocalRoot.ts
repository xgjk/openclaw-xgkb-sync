import * as fs from 'fs';
import * as path from 'path';

/**
 * 确保 mapping 的 localRoot 目录在磁盘上存在（recursive mkdir）。
 * 新建 mapping 或热重载启动 watcher 前调用，避免目录尚未创建导致 chokidar 跳过。
 */
export function ensureMappingLocalRoot(
  localRoot: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = localRoot.trim();
  if (!trimmed) {
    return { ok: false, error: 'localRoot 不能为空' };
  }

  const resolved = path.resolve(trimmed);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    return { ok: true, path: resolved };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `无法创建 localRoot 目录 "${resolved}": ${msg}` };
  }
}

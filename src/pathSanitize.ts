/** 文件名中的非法字符（Windows/跨平台安全子集） */
const ILLEGAL_IN_SEGMENT = /[*"<>:|?\\]/g;

/** 将单个路径段中的非法字符替换为 "-" */
export function sanitizePathSegment(segment: string): string {
  return segment.replace(ILLEGAL_IN_SEGMENT, '-');
}

/**
 * 清理相对路径（"/" 分隔）中的每一段，保证路径可安全落盘。
 * 不修改 "/" 分隔符本身。
 */
export function sanitizeRelativePath(relativePath: string): string {
  if (!relativePath) return relativePath;
  return relativePath
    .split('/')
    .map((seg) => sanitizePathSegment(seg))
    .join('/');
}

/** 统一路径分隔符为 "/" */
export function normalizeSeparator(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * 将「同步根之下的相对路径」规范到逻辑子树内：逐段 sanitize 后折叠 `.`/`..`，
 * 栈为空时丢弃多余的 `..`，避免 ../../../ 跳出同步目录（见 LocalFsAdapter.resolve）。
 */
export function canonicalizeRelativeSyncPath(relativePath: string): string {
  if (!relativePath) return '';
  const parts: string[] = [];
  for (const seg of normalizeSeparator(relativePath).split('/')) {
    if (!seg || seg === '.') continue;
    const s = sanitizePathSegment(seg);
    if (!s || s === '.') continue;
    if (s === '..') parts.pop();
    else parts.push(s);
  }
  return parts.join('/');
}

/**
 * 在远端路径集合中，若某条路径的任一前缀（按 "/" 分段）本身也是集合中的一条完整路径，
 * 则说明知识库里「同名文档节点」下还挂了子文件；本地文件系统无法同时把它当作文件与其子路径，
 * 此类更深的路径应视为不可镜像并跳过。
 *
 * @returns 应跳过的路径集合（不含自身即为前缀的那些路径）
 */
export function pathsShadowedByAncestorFiles(allPaths: Iterable<string>): Set<string> {
  const set = new Set(allPaths);
  const shadowed = new Set<string>();
  for (const q of set) {
    const parts = q.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (set.has(prefix)) {
        shadowed.add(q);
        break;
      }
    }
  }
  return shadowed;
}

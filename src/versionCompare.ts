/**
 * 比较两个 semver 风格版本号（支持可选 v 前缀）。
 * @returns 1 if a>b, -1 if a<b, 0 if equal；无法解析时按字符串比较并返回 null 标记
 */
export function compareVersions(
  a: string,
  b: string,
): { result: -1 | 0 | 1; parsed: boolean } {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    const sa = a.trim();
    const sb = b.trim();
    if (sa === sb) return { result: 0, parsed: false };
    return { result: sa > sb ? 1 : -1, parsed: false };
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return { result: pa[i] > pb[i] ? 1 : -1, parsed: true };
    }
  }
  return { result: 0, parsed: true };
}

export function isNewerVersion(latest: string, current: string): boolean {
  const { result } = compareVersions(latest, current);
  return result > 0;
}

function parseVersion(raw: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

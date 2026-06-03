"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareVersions = compareVersions;
exports.isNewerVersion = isNewerVersion;
/**
 * 比较两个 semver 风格版本号（支持可选 v 前缀）。
 * @returns 1 if a>b, -1 if a<b, 0 if equal；无法解析时按字符串比较并返回 null 标记
 */
function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) {
        const sa = a.trim();
        const sb = b.trim();
        if (sa === sb)
            return { result: 0, parsed: false };
        return { result: sa > sb ? 1 : -1, parsed: false };
    }
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) {
            return { result: pa[i] > pb[i] ? 1 : -1, parsed: true };
        }
    }
    return { result: 0, parsed: true };
}
function isNewerVersion(latest, current) {
    const { result } = compareVersions(latest, current);
    return result > 0;
}
function parseVersion(raw) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
    if (!m)
        return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}
//# sourceMappingURL=versionCompare.js.map
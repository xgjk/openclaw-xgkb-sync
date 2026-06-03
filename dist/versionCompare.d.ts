/**
 * 比较两个 semver 风格版本号（支持可选 v 前缀）。
 * @returns 1 if a>b, -1 if a<b, 0 if equal；无法解析时按字符串比较并返回 null 标记
 */
export declare function compareVersions(a: string, b: string): {
    result: -1 | 0 | 1;
    parsed: boolean;
};
export declare function isNewerVersion(latest: string, current: string): boolean;
//# sourceMappingURL=versionCompare.d.ts.map
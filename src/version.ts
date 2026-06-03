import * as fs from 'fs';
import * as path from 'path';

/** 读取 package.json 里的版本号，失败则返回 'unknown' */
export function readAppVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const APP_VERSION = readAppVersion();

import * as os from 'os';

/** 虚拟/容器网卡名前缀（小写匹配） */
const VIRTUAL_IFACE_RE =
  /^(lo|docker|veth|br-|virbr|vmnet|vboxnet|vethernet|tun|tap|wg|zt|tailscale|npcap)/i;

const LOOPBACK_RE = /^127\./;
const LINK_LOCAL_RE = /^169\.254\./;
const ZERO_RE = /^0\./;

export class NodeIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeIdentityError';
  }
}

export interface ResolveAdvertiseIpOptions {
  /** 显式指定对外宣告 IP，优先级最高 */
  advertiseIp?: string;
  /** 额外排除的网卡名（正则字符串或字面量，不区分大小写） */
  excludeInterfaces?: string[];
}

export interface BuildNodeIdOptions extends ResolveAdvertiseIpOptions {
  /** 完整覆盖 nodeId（如运维手工登记），不再拼接 IP:端口 */
  nodeId?: string;
  managementPort: number;
}

function isIpv4(family: string | number | undefined): boolean {
  return family === 'IPv4' || family === 4;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function isExcludedInterface(name: string, extra?: string[]): boolean {
  const lower = name.toLowerCase();
  if (VIRTUAL_IFACE_RE.test(lower)) return true;
  if (!extra?.length) return false;
  return extra.some((pat) => {
    try {
      return new RegExp(pat, 'i').test(lower);
    } catch {
      return lower.includes(pat.toLowerCase());
    }
  });
}

function scoreCandidate(ifaceName: string, address: string, internal: boolean): number {
  let score = 0;
  if (isPrivateIpv4(address)) score += 100;
  if (!internal) score += 40;
  if (!isExcludedInterface(ifaceName)) score += 30;
  // 同分时稳定排序：优先非 internal、再按 IP 字典序
  return score;
}

interface Candidate {
  iface: string;
  address: string;
  internal: boolean;
  score: number;
}

/**
 * 从本机网卡中选取「最能代表机器内网身份」的 IPv4。
 * 禁止返回 127.0.0.1；无可用地址时抛错，要求配置 nodeAdvertiseIp。
 */
export function resolveAdvertiseIpv4(opts: ResolveAdvertiseIpOptions = {}): string {
  const explicit = opts.advertiseIp?.trim();
  if (explicit) {
    assertUsableAdvertiseIp(explicit, true);
    return explicit;
  }

  const candidates: Candidate[] = [];
  const ifaces = os.networkInterfaces();

  for (const [ifaceName, addrs] of Object.entries(ifaces)) {
    if (!addrs?.length || isExcludedInterface(ifaceName, opts.excludeInterfaces)) continue;

    for (const addr of addrs) {
      if (!isIpv4(addr.family)) continue;
      const ip = addr.address;
      if (LOOPBACK_RE.test(ip) || LINK_LOCAL_RE.test(ip) || ZERO_RE.test(ip)) continue;

      candidates.push({
        iface: ifaceName,
        address: ip,
        internal: !!addr.internal,
        score: scoreCandidate(ifaceName, ip, !!addr.internal),
      });
    }
  }

  if (candidates.length === 0) {
    throw new NodeIdentityError(
      '无法自动解析本机内网 IPv4（仅有回环或虚拟网卡）。请在 config.json 中设置 nodeAdvertiseIp，或设置完整 nodeId。',
    );
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.internal !== b.internal) return a.internal ? 1 : -1;
    return a.address.localeCompare(b.address, undefined, { numeric: true });
  });

  const best = candidates[0];
  assertUsableAdvertiseIp(best.address, false);
  return best.address;
}

function assertUsableAdvertiseIp(ip: string, fromConfig: boolean): void {
  if (LOOPBACK_RE.test(ip)) {
    throw new NodeIdentityError(
      fromConfig
        ? `nodeAdvertiseIp 不能使用回环地址 ${ip}`
        : `自动解析到回环地址 ${ip}，请设置 nodeAdvertiseIp`,
    );
  }
  if (LINK_LOCAL_RE.test(ip)) {
    throw new NodeIdentityError(
      fromConfig
        ? `nodeAdvertiseIp 不能使用链路本地地址 ${ip}`
        : `自动解析到链路本地地址 ${ip}，请设置 nodeAdvertiseIp`,
    );
  }
}

/**
 * 构建节点唯一 ID：`{内网IP}:{管理端口}`。
 * 若配置 nodeId 则原样使用（运维兜底）。
 */
export function buildNodeId(opts: BuildNodeIdOptions): string {
  const override = opts.nodeId?.trim();
  if (override) {
    if (/^127\.0\.0\.1(?::|$)/.test(override) || override.startsWith('localhost')) {
      throw new NodeIdentityError(`nodeId 不能使用 127.0.0.1 或 localhost: ${override}`);
    }
    return override;
  }

  const port = opts.managementPort;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new NodeIdentityError(`managementPort 无效: ${port}`);
  }

  const ip = resolveAdvertiseIpv4({
    advertiseIp: opts.advertiseIp,
    excludeInterfaces: opts.excludeInterfaces,
  });
  return `${ip}:${port}`;
}

export type NodeIdentityInfo = {
  nodeId: string;
  advertiseIp: string;
  managementPort: number;
  source: 'nodeId' | 'nodeAdvertiseIp' | 'auto';
};

/** 解析结果摘要，供心跳 /health 上报 */
export function describeNodeIdentity(opts: BuildNodeIdOptions): NodeIdentityInfo {
  if (opts.nodeId?.trim()) {
    const nodeId = buildNodeId(opts);
    const m = /^([^:]+):(\d+)$/.exec(nodeId);
    return {
      nodeId,
      advertiseIp: m?.[1] ?? opts.advertiseIp?.trim() ?? 'unknown',
      managementPort: m ? Number(m[2]) : opts.managementPort,
      source: 'nodeId',
    };
  }
  if (opts.advertiseIp?.trim()) {
    return {
      nodeId: buildNodeId(opts),
      advertiseIp: opts.advertiseIp.trim(),
      managementPort: opts.managementPort,
      source: 'nodeAdvertiseIp',
    };
  }
  const ip = resolveAdvertiseIpv4(opts);
  return {
    nodeId: `${ip}:${opts.managementPort}`,
    advertiseIp: ip,
    managementPort: opts.managementPort,
    source: 'auto',
  };
}

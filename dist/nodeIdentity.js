"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeIdentityError = void 0;
exports.resolveAdvertiseIpv4 = resolveAdvertiseIpv4;
exports.buildNodeId = buildNodeId;
exports.describeNodeIdentity = describeNodeIdentity;
const os = __importStar(require("os"));
/** 虚拟/容器网卡名前缀（小写匹配） */
const VIRTUAL_IFACE_RE = /^(lo|docker|veth|br-|virbr|vmnet|vboxnet|vethernet|tun|tap|wg|zt|tailscale|npcap)/i;
const LOOPBACK_RE = /^127\./;
const LINK_LOCAL_RE = /^169\.254\./;
const ZERO_RE = /^0\./;
class NodeIdentityError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NodeIdentityError';
    }
}
exports.NodeIdentityError = NodeIdentityError;
function isIpv4(family) {
    return family === 'IPv4' || family === 4;
}
function isPrivateIpv4(ip) {
    const parts = ip.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n)))
        return false;
    if (parts[0] === 10)
        return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        return true;
    if (parts[0] === 192 && parts[1] === 168)
        return true;
    return false;
}
function isExcludedInterface(name, extra) {
    const lower = name.toLowerCase();
    if (VIRTUAL_IFACE_RE.test(lower))
        return true;
    if (!extra?.length)
        return false;
    return extra.some((pat) => {
        try {
            return new RegExp(pat, 'i').test(lower);
        }
        catch {
            return lower.includes(pat.toLowerCase());
        }
    });
}
function scoreCandidate(ifaceName, address, internal) {
    let score = 0;
    if (isPrivateIpv4(address))
        score += 100;
    if (!internal)
        score += 40;
    if (!isExcludedInterface(ifaceName))
        score += 30;
    // 同分时稳定排序：优先非 internal、再按 IP 字典序
    return score;
}
/**
 * 从本机网卡中选取「最能代表机器内网身份」的 IPv4。
 * 禁止返回 127.0.0.1；无可用地址时抛错，要求配置 nodeAdvertiseIp。
 */
function resolveAdvertiseIpv4(opts = {}) {
    const explicit = opts.advertiseIp?.trim();
    if (explicit) {
        assertUsableAdvertiseIp(explicit, true);
        return explicit;
    }
    const candidates = [];
    const ifaces = os.networkInterfaces();
    for (const [ifaceName, addrs] of Object.entries(ifaces)) {
        if (!addrs?.length || isExcludedInterface(ifaceName, opts.excludeInterfaces))
            continue;
        for (const addr of addrs) {
            if (!isIpv4(addr.family))
                continue;
            const ip = addr.address;
            if (LOOPBACK_RE.test(ip) || LINK_LOCAL_RE.test(ip) || ZERO_RE.test(ip))
                continue;
            candidates.push({
                iface: ifaceName,
                address: ip,
                internal: !!addr.internal,
                score: scoreCandidate(ifaceName, ip, !!addr.internal),
            });
        }
    }
    if (candidates.length === 0) {
        throw new NodeIdentityError('无法自动解析本机内网 IPv4（仅有回环或虚拟网卡）。请在 config.json 中设置 nodeAdvertiseIp，或设置完整 nodeId。');
    }
    candidates.sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        if (a.internal !== b.internal)
            return a.internal ? 1 : -1;
        return a.address.localeCompare(b.address, undefined, { numeric: true });
    });
    const best = candidates[0];
    assertUsableAdvertiseIp(best.address, false);
    return best.address;
}
function assertUsableAdvertiseIp(ip, fromConfig) {
    if (LOOPBACK_RE.test(ip)) {
        throw new NodeIdentityError(fromConfig
            ? `nodeAdvertiseIp 不能使用回环地址 ${ip}`
            : `自动解析到回环地址 ${ip}，请设置 nodeAdvertiseIp`);
    }
    if (LINK_LOCAL_RE.test(ip)) {
        throw new NodeIdentityError(fromConfig
            ? `nodeAdvertiseIp 不能使用链路本地地址 ${ip}`
            : `自动解析到链路本地地址 ${ip}，请设置 nodeAdvertiseIp`);
    }
}
/**
 * 构建节点唯一 ID：`{内网IP}:{管理端口}`。
 * 若配置 nodeId 则原样使用（运维兜底）。
 */
function buildNodeId(opts) {
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
/** 解析结果摘要，供心跳 /health 上报 */
function describeNodeIdentity(opts) {
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
//# sourceMappingURL=nodeIdentity.js.map
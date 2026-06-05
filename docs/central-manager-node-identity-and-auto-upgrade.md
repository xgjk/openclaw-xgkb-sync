# 节点身份（nodeId）与自动升级

> 配置对齐约定见 [sync-manage-integration-alignment.md](./sync-manage-integration-alignment.md)（节点对下发 `data.config` 做 merge，不维护固定白名单）。
> 本文聚焦：**nodeId 必须反映真实内网 IP**、**发现新版本后如何自动升级**。

---

## 1. nodeId：唯一性与真实 IP

### 1.1 约定格式

```
{内网IPv4}:{managementPort}
```

示例：`192.168.1.100:9090`

- 禁止使用 `127.0.0.1`、`localhost` 作为 nodeId 的 IP 部分。
- `managementPort` 使用进程实际监听端口（与 `config.json` 中 `managementPort` 一致）。

### 1.2 解析优先级（本仓库 `src/nodeIdentity.ts`）

| 优先级 | 配置项 | 说明 |
|--------|--------|------|
| 1 | `nodeId` | 完整覆盖，运维手工登记时使用 |
| 2 | `nodeAdvertiseIp` + `managementPort` | 多网卡机器指定对外 IP |
| 3 | 自动探测 | 从 `os.networkInterfaces()` 选最优 IPv4 |

自动探测规则：

- 排除：回环 `127.*`、链路本地 `169.254.*`、`0.*`
- 排除网卡名：`docker*`、`veth*`、`br-*`、`vmnet*`、`vboxnet*`、`tun*`、`wg*` 等
- 优先：RFC1918 私网地址（10/172.16–31/192.168）、`internal=false` 的接口
- 多候选时取得分最高者；仍无法解析则**启动失败**，提示配置 `nodeAdvertiseIp`

### 1.3 多网卡 / 特殊环境

| 场景 | 建议 |
|------|------|
| 物理机双网卡 | 在 `config.json` 写 `nodeAdvertiseIp` 为运维认定的内网 IP |
| 仅 Docker 网桥 | 自动探测会失败或选错，必须显式 `nodeAdvertiseIp` |
| NAT 后多台机器 | 每台机器 IP 不同，nodeId 自然不同；不要用相同 `nodeId` 覆盖 |

### 1.4 配置示例

```json
{
  "managementPort": 9090,
  "nodeAdvertiseIp": "192.168.1.100"
}
```

或完整指定：

```json
{
  "nodeId": "192.168.1.100:9090"
}
```

---

## 2. 自动升级：从「发现版本」到「真正升级」

### 2.1 为什么不能只在 Node 进程里 `git pull`？

正在运行的 Node 进程**不能安全替换**自身的 `dist/` 与 `node_modules`（文件被占用）。正确做法是：

1. 主进程发现 `latestAppVersion` > 当前 `package.json` 版本；
2. 确认**无进行中的 mapping 同步**；
3. **拉起独立升级脚本**（detached）；
4. 脚本：停服 → 拉代码/切 tag → `npm install` → `npm run build` → **pm2/systemd 重启**。

本仓库提供：

- `src/versionCompare.ts` — 版本比较
- `src/autoUpgrade.ts` — 空闲检测 + 触发脚本
- `scripts/auto-upgrade.sh` / `scripts/auto-upgrade.ps1` — 实际升级动作

### 2.2 启用方式（接入心跳后）

在 `config.json` 中（字段待心跳模块一并接入）：

```json
{
  "autoUpgradeEnabled": true,
  "autoUpgradeScript": "./scripts/auto-upgrade.sh"
}
```

心跳响应里 `data.latestAppVersion` 大于当前版本时，调用 `maybeScheduleAutoUpgrade()`。

### 2.3 升级脚本前提

| 前提 | 说明 |
|------|------|
| 部署方式 | 推荐 **git clone** 安装（见 [INSTALL_AND_UPDATE.md](./INSTALL_AND_UPDATE.md)） |
| 进程管理 | **pm2** 或 **systemd** 二选一；否则脚本只 build，需人工 `npm start` |
| 发版 | 中心 Nacos 的 `openclaw.sync.latest-version` 与 git tag（如 `v1.0.6`）一致 |
| 网络 | 机器能 `git fetch` / `npm install` |
| 脚本权限 | **无需**手动 `chmod +x`：节点用 `bash auto-upgrade.sh`（Mac/Linux）或 `powershell -File auto-upgrade.ps1`（Windows）启动；仓库内 `.sh` 亦已设 git 可执行位 |

**跨平台说明**

| 平台 | 默认脚本 | 启动方式 |
|------|----------|----------|
| Windows | `scripts/auto-upgrade.ps1` | `powershell -ExecutionPolicy Bypass -File …` |
| macOS / Mac mini / Linux | `scripts/auto-upgrade.sh` | `/bin/bash scripts/auto-upgrade.sh …` |
| 无 pm2/systemd | 同上 | 按 `config.json` 的 `managementPort` 停旧进程，再 **`node dist/index.js`** 后台启动（不用 `npm start`，避免 Mac PATH 丢失） |
| 排查 | `logs/auto-upgrade.log`（升级脚本全程） / `logs/auto-upgrade-restart.log`（新进程 stdout） |

### 2.4 安全闸门

- 同步进行中不升级（`scheduler` 无活跃 sync）
- 同一目标版本只触发一次升级尝试（避免心跳每 30s 重复拉）
- 不覆盖 `config.json`、SQLite 状态库（与手动更新一致）

### 2.5 若不用 git：制品包方案（需 sync-manage 扩展）

当前 heartbeat **只返回版本号**。若未来中心增加：

```json
{
  "latestAppVersion": "1.0.6",
  "artifactUrl": "https://.../openclaw-xgkb-sync-1.0.6.tgz",
  "artifactSha256": "..."
}
```

则升级脚本改为：下载 → 校验 → 解压到 `releases/1.0.6` → 切换符号链接 → 重启。  
**本期未实现**，待中心确认后再做。

---

## 3. 与 sync-manage 的衔接（待办）

| 能力 | 节点侧 | 中心侧 |
|------|--------|--------|
| 心跳上报 nodeId | Header `X-Node-Id` + body `ipAddress` | 已支持 |
| 发现新版本 | 比对 `latestAppVersion` | Nacos `@RefreshScope` |
| 自动升级 | 本文件 + `autoUpgrade.ts` | 可选下发 artifact（未来） |
| 配置下发 | 节点对 `data.config` **merge**（不维护白名单副本） | 中心可配置托管字段 |

---

## 4. 验证清单

```bash
# 启动日志应出现 nodeId（非 127.0.0.1）
npm start

# health 应含 nodeId / advertiseIp
curl http://127.0.0.1:9090/health

# 手动测升级脚本（先停服务）
./scripts/auto-upgrade.sh 1.0.6 1.0.5
```

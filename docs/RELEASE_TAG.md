# 发版与 Git Tag 操作指南

用于 `openclaw-xgkb-sync` 发布新版本：与 `package.json` 的 `version`、GitHub Tag、sync-manage Nacos 的 `openclaw.sync.latest-version` 保持一致。

自动升级脚本会执行：`git fetch --tags` → `git checkout v{version}` → `npm install` → `npm run build` → `pm2 restart`。

---

## 一、版本号约定

| 项 | 格式 | 示例 |
|----|------|------|
| `package.json` → `version` | `主.次.修订` | `1.0.6` |
| Git Tag（推荐） | `v` + 版本号 | `v1.0.6` |
| Nacos `openclaw.sync.latest-version` | 与上相同（可不带 `v`） | `1.0.6` |

---

## 二、一键发版（推荐）

### Windows（PowerShell）

在项目根目录执行：

```powershell
# 仅打 tag 并推送（当前提交已包含版本号变更）
.\scripts\release-tag.ps1 -Push

# 指定版本（会先改 package.json，再提交、打 tag、推送）
.\scripts\release-tag.ps1 -Version 1.0.6 -Push

# 只打本地 tag，不 push（检查用）
.\scripts\release-tag.ps1 -Version 1.0.6
```

### Linux / macOS

```bash
chmod +x scripts/release-tag.sh
./scripts/release-tag.sh --push
./scripts/release-tag.sh --version 1.0.6 --push
```

### 脚本会做什么

1. 读取或设置 `package.json` 的 `version`
2. 检查工作区是否干净（可用 `-Force` 跳过）
3. 若有版本变更：`git add package.json` + `git commit`
4. `git tag -a v{version} -m "release {version}"`
5. 若带 `-Push` / `--push`：`git push` 当前分支 + `git push origin v{version}`

---

## 三、手动命令（与脚本等价）

```powershell
cd D:\code\plugins\github-openclaw-xgkb-sync

# 1. 改 package.json 中 "version": "1.0.6"

git add package.json
git commit -m "chore: release 1.0.6"

git tag -a v1.0.6 -m "release 1.0.6"

git push origin main
git push origin v1.0.6
```

默认分支若为 `master`，将 `main` 改为 `master`。

---

## 四、发版后检查清单

| 步骤 | 操作 |
|------|------|
| GitHub | 仓库 → Tags / Releases 中可见 `v1.0.6` |
| Nacos | `openclaw.sync.latest-version` = `1.0.6` |
| 节点 | 下次心跳发现新版本，空闲时执行 `scripts/auto-upgrade.*` |
| 验证 | 节点 `GET /health` 的 `version` 为 `1.0.6` |

---

## 五、常用维护命令

```bash
git tag -l "v*"
git show v1.0.6
git tag -d v1.0.6
git push origin --delete v1.0.6
```

---

## 六、相关文档

- [INSTALL_AND_UPDATE.md](./INSTALL_AND_UPDATE.md) — 节点手动/脚本升级
- [central-manager-node-identity-and-auto-upgrade.md](./central-manager-node-identity-and-auto-upgrade.md) — nodeId 与自动升级
- sync-manage：[节点集成文档.md](https://github.com/xgjk/sync-manage)（以实际仓库路径为准）

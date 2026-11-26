# 发版台账 — Sweep

按**证据**记录，不按预期。状态只能跟着证据改。

## v1.0.0 — 2026-11-26

| 项 | 值 |
|---|---|
| 版本 | 1.0.0 |
| 打包时间 | 2026-11-26 10:5x |
| zip | `out/sweep-1.0.0.zip` |
| 字节数 | 54,052（解压后 118,036） |
| sha256 | `07a8a6098d2c0e4777f3f2be6701c53ccf05a7d54d9c0005f685d6ec9f09e49c` |
| 条目数 | 22 |
| 提交 | `main` 分支 |

### 状态

| 步骤 | 证据 | 状态 |
|---|---|---|
| 打包 + 结构校验 | manifest 在 zip 根目录，22 条目，无源码/工具混入 | ✅ |
| 真实 Chrome 加载 | CDP `Extensions.loadUnpacked` 返回 id `blepmahgfjffaamiiehgnicncieiacpd` | ✅ |
| 真实 API 清理 | 造 4 条历史 → 清理后 0 条，零错误，46ms | ✅ |
| Cookie 修复验证 | 修复前写法被拒（`At least one data type doesn't support filtering by origin.`），修复后通过 | ✅ |
| 保留名单验证 | `google.com` / `mail.google.com` 保住，`example.com` 被删 | ✅ |
| 隐私政策上线 | https://hibernate-pano.github.io/sweep/ 返回 200 | ✅ |
| 商店 listing | **未创建** —— 需要人工在开发者后台「Add new item」 | ⬜ |
| 上传（upload） | 未做（等 listing） | ⬜ |
| 提交审核（publish） | 未做 | ⬜ |
| 上架 | 未做 | ⬜ |

### 为什么还没上传

Chrome Web Store API **没有「创建 item」的接口**（已核实：官方文档与兄弟项目
`chrome-plugin-manga-translator` 的发布文档都写明，`/items` 只能操作已存在的 item）。
第一个 listing 必须在开发者后台手工建：

1. 打开 https://chrome.google.com/webstore/devconsole
2. **Add new item** → 上传 `out/sweep-1.0.0.zip`
3. 按 `store/listing.md` 填商店信息、隐私问卷、权限理由、审核备注
4. 上传 `store/shots/` 里的截图与宣传图
5. 保存后，从 URL 拿到 item id（`devconsole/<ITEM_ID>`）

拿到 item id 之后，后续版本就都是命令行了：

```bash
node scripts/cws-release.mjs status  --item-id <ID> --proxy http://127.0.0.1:7890
node scripts/cws-release.mjs upload  out/sweep-1.0.0.zip --item-id <ID> --proxy http://127.0.0.1:7890
node scripts/cws-release.mjs publish 1.0.0 --item-id <ID> --proxy http://127.0.0.1:7890
node scripts/cws-release.mjs live    --item-id <ID> --proxy http://127.0.0.1:7890
```

> **代理注意**：`~/.config/mcp/mcp.json` 里写的是 `7897`，但本机实际监听的是 **7890**
> （FlClash）。而且这个代理对 Google API 是**不稳定**的——实测 5 次里有 2 次成功，
> 需要重试（`--retries 5`）。

## 复现打包

```bash
node scripts/zip-extension.mjs . out/sweep-1.0.0.zip \
  --exclude ".git/*" --exclude "scripts/*" --exclude "store/*" --exclude "tools/*" \
  --exclude "docs/*" --exclude "out/*" --exclude "PRIVACY.md" --exclude "LICENSE" \
  --exclude ".gitignore" --exclude ".DS_Store"
```

比对 sha256 是否与台账一致——一致才说明是同一份产物。

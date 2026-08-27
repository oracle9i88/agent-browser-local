# CHANGES：登录态迁移向导（Chrome → Agent）— 交付审计文档

> 实现方：GLM（glm-5.3-flash）。分支 `glm/profile-migration`，基线 `4cedd9e`。
> 状态：**待 Codex 审计**。不自行合并、不推送、不宣布完成。
> 本文档是实现方对十条硬约束的自证与架构决策记录，供审计对照。

## 0. 架构决策（请 Codex 裁决）

采用方案 A（CDP 会话桥），审计口径按修正后的表述：

> CDP 会话桥**不读取非授权 Cookie**（协议层用 `Network.getCookies{urls}` 按 URL 过滤，
> 非授权 Cookie 不会进入内存）；对**用户逐域明确授权**的 Cookie，其明文值只在
> **Electron 主进程内存中短暂处理**，随后注入 Agent Cookie store 并立即丢弃——
> 不持久化、不展示、不记录、不出主进程（不进 Renderer / daemon API / 审计日志 /
> 文件 / Agent Snapshot）。

辅助决策：非凭据文件级拷贝（bookmarks、localStorage 等）**未实现**——本次修订范围
（六文件清单）只含登录态迁移；localStorage 跨 Chromium 版本的 LevelDB 兼容风险与
令牌泄漏面，留待 Codex 决定是否立项。

## 1. 变更清单（相对基线 `4cedd9e`）

| 提交 | 内容 |
| --- | --- |
| `3e2884d` | `src/profile/chrome-profile-detector.mjs` + `test/profile/chrome-profile-detector.test.mjs` |
| `2e72612` | `src/profile/profile-migrator.mjs` + `test/profile/profile-migrator.test.mjs` + `src/browser/chrome-cdp.mjs`（新增 2 函数） |
| `30ecb06` | `src/ui/migration-wizard.js`（新建）+ `src/main.mjs` / `src/preload.cjs` / `src/ui/index.html` / `src/ui/styles.css`（最小接线） |

范围说明：

- 六文件清单中的 `auth-bridge.mjs` **未改动**（列表为"负责"非"必改"；Suno 既有
  external-auth 流程保持原样，迁移走独立通道）。
- 接线必需但超出六文件清单的文件（均为向导专用最小 diff，逐行可审）：
  `src/preload.cjs`（+4 个 IPC 桥函数）、`src/ui/index.html`（+1 个 script 标签）、
  `src/ui/styles.css`（纯追加样式块）、`src/main.mjs`（+4 个 IPC handler + 导入 +
  manifest 存储实例）。

## 2. 十条硬约束 → 实现位置对照

| # | 约束 | 实现 | 证据/测试 |
| --- | --- | --- | --- |
| 1 | 点击"开始同步"后才允许 CDP | `migration:run` handler 仅由向导按钮触发（`migration-wizard.js: startSync`）；daemon/HTTP API 无任何迁移端点 | 代码审阅；`src/server/**` 零改动 |
| 2 | 先展示域名列表，逐域勾选 | 向导按平台渲染域名 checkbox，默认全不选；未勾选时按钮禁用 | `migration-wizard.js renderOffers` |
| 3 | Google 域永远禁止导入 | 双层防线：结构层（offers 白名单不含 Google 域）+ 校验层（`MIGRATION_DENIED_DOMAIN_SUFFIXES` 后缀匹配拒绝 `google.com` / `accounts.youtube.com` 及其子域） | `profile-migrator.test.mjs "offers never contain google identity domains"`、`"selection validation rejects google domains…"` |
| 4 | 每平台独立 Cookie 白名单，不能整站导入 | `MIGRATION_PLATFORM_OFFERS` 每平台固定 `domains` + `cookieNames`；CDP URL 过滤后仍有名字白名单过滤，未列名丢弃 | `"migration filters by name whitelist…"`（注入的 unlisted_cookie 被丢弃） |
| 5 | Cookie 值只存主进程内存 | 值只存在于 `runLoginMigration` 作用域内的局部变量；摘要/manifest/错误信息只含计数、域名、Cookie **名**；测试注入 `SECRET-…` 值并断言 summary 与 manifest 序列化结果均不含 | `"…returns value-free summary"`、manifest 断言 |
| 6 | 同步完成即丢弃、无导出 | 注入完成后 `entry.cookies = null`、`injectedCookies.length = 0`；未提供任何导出 API | `runLoginMigration` 尾部 |
| 7 | 每平台同步前/后登录验证 | 前：Chrome 中须有该平台 target 且必需 Cookie（`requiredCookieNames`）齐全；后：从 Agent cookie store 回读每条注入项。UI 侧另提供"打开验证"引导用户逐平台人工确认 | `"pre-sync verification fails…"` ×2、`"post-sync verification failure…"` |
| 8 | 失败自动回滚，不破坏现有 Profile | 任何平台前置校验失败→尚未注入；注入/验证阶段失败→按已注入清单自动 `cookies.remove`；显式回滚只动 manifest 列出的 Cookie。注入后立即登记回滚清单（修过一个真实缺口：验证失败时本条目已注入项漏回滚，测试 `constraint 8` 抓出后已修复） | `"post-sync verification failure triggers automatic rollback"`、`"rollback removes exactly the manifest-listed cookies"` |
| 9 | Agent 不得自行决定域名/Cookie 名/权限 | 域名与 Cookie 名都是代码内静态白名单；勾选只能是其子集；daemon 能力集（`constants.CAPABILITIES`）零改动，Agent 无迁移能力 | `validateMigrationSelection` 拒绝白名单外域名；`git diff main -- src/constants.mjs src/server src/security` 应为空 |
| 10 | 人机验证/2FA/发布/支付仍人工 | 向导只读 Cookie + 注入；提示文案明确"始终由你本人完成"；`risk-policy` / `contribution-policy` / `external-auth` / daemon 零改动 | `git diff main..HEAD --stat` 中无上述文件 |

## 3. Chrome 原 Profile 的只读性

- `chrome-profile-detector.mjs`：仅 `readFile` / `readdir` / `stat`，无任何写、改名、
  删除操作；测试断言探测后源文件内容与 mtime 不变。
- CDP 路径：只调用 `Network.getCookies`（只读），不挂载、不复制、不修改任何 Profile 文件。
- 回滚：只移除 manifest 中记录的、此前注入到 Agent cookie store 的条目，与 Chrome Profile 无关。

## 4. 实现方已完成的自测

- `npm run check`：61 文件语法通过。
- `npm test`：87 tests，86 pass / 0 fail / 1 skipped（基线 73 pass，新增 13 pass + 1 skipped 原有）。
- 无头启动冒烟（临时 runtime、独立端口）：daemon 监听、UI 初始化、自动退出正常。

## 5. 留给 Codex 的验收项（实现方未做、也不应自判）

1. `npm run package:mac` + `npm run test:packaged` 打包冒烟（避免覆盖现有 dist 产物，未执行）。
2. 六平台真实登录迁移验收：Suno / 公众号 / 抖音 / 小红书 / 快手 / 网易云。
   **各平台 cookieNames 是实现方基于公开资料的建议值，须经真实验收校准**，尤其是
   公众号（slave_user/slave_sid/pass_ticket）与快手（webday7_st/webday7_ph）。
3. 回滚演练：同步 → 回滚 → 确认 Agent 恢复未登录态且其他数据无损。
4. 越权面复核：`git diff main..HEAD -- src/security src/server src/constants.mjs src/browser/auth-bridge.mjs src/browser/external-auth.mjs src/browser/chrome-launcher.mjs` 应为空（cdp-session.mjs 亦未动）。
5. 明文泄漏面复核：向导 IPC 返回值、manifest 文件（`<runtime>/migration/manifest.json`，0600）、审计日志中不得出现 Cookie 值。

## 6. 已知限制 / 假设

- CDP 依赖运行中的 Chrome 调试端点（`ABL_CHROME_CDP_URL`，默认 `http://127.0.0.1:9222`），与既有 Suno 同步流程一致。
- Profile 探测结果仅作展示与确认（"以当前运行中的 Chrome 会话为准"已写入向导文案）；CDP 天然跟随运行中的 Chrome 实例。
- `sameSite` 归一化与既有 `auth-bridge.mjs` 口径一致（`none → no_restriction`）。
- 迁移向导按钮挂在工具栏（`#handoff` 之前），未与 daemon 状态联动；daemon 未就绪时向导仍可使用（迁移是纯本地人工操作，不需要 Agent 能力授权）。

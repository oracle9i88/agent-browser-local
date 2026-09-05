# Changelog

## v0.3.0-beta.14 — 2026-09-05

- 将 Suno 实际使用中的 `/studio-welcome` 跳转页纳入精确贡献白名单，避免已登录用户首次进入 Studio 时被本地安全层误冻结。
- 修复迁移向导首次点击时等待 Chrome 探测却不渲染的假死体验：面板立即出现并显示加载状态，未选择域名时按钮明确提示“先勾选域名”；13×13 像素复选框扩展为整块可点击域名按钮。
- 修复 Electron `WebContentsView` 覆盖迁移面板的真实窗口层级问题：向导打开时隐藏网页视图，关闭时恢复；打包 smoke 同时验证开、关两态的合成层可见性。
- 增加持久化、独立 Profile 的真实 Chrome 会话桥入口，解决现代 Chrome 不允许对日常默认 Profile 临时开启远程调试而导致的 `migration:run fetch failed`；普通 Chrome 不受影响，Google Cookie 仍不导入 Agent Space。
- 按 2026-09-05 真实 Suno 登录会话校准最小白名单：`suno.com` 的 session、Clerk 活跃时间与恢复上下文，必须和 `auth.suno.com` 的 Clerk client/sessionid 在首次加载前一次性迁入；Google、统计、广告、Stripe 和设备追踪 Cookie 继续拒绝。真实故障证明“Cookie 已写入”不等于登录成功，验收必须在页面看到 Profile menu 与 credits，且不再出现 Log in。
- 修复 Chrome 同时存在 host-only `suno.com` 与 domain `.suno.com` 两枚同名 `__session` 时 Electron 静默互相覆盖：迁移器按当前 Clerk 流程稳定选择 host-only 会话，并对最终域/路径逐枚精确读回；只选主站域或缺少 `auth.suno.com` client 时同步前直接失败，不再制造半套登录态。
- 修复 Suno Studio 内层滚动误用顶层页面 `pageY` 的 P0：改为来自当前截图的 60 秒视觉锚点；完整 PNG 持续保存，但到底判定只哈希左侧轨道编号/名称栏，避免 Magic Bar 轮换提示让整屏哈希永不稳定。连续两次轨道栏不变才报告到底；固定坐标不可复用。
- Suno 大型多轨工程的截图命令使用独立 30 秒上限；超时仍冻结并写失败 manifest，但不再因默认 15 秒门槛误伤偶发的重页面截图。
- 下载自动落盘改为一次性短期许可，只能由已获 `browser.finalize.ref` 权限且经风险策略识别、审计的 Studio `Export → Multitrack` 触发；普通歌曲页 Download 不借用 Studio 的不限额通道，同名文件自动避让。
- `browser.click` / `browser.clickVisual` 新增受限的 `mouseButton: "right"`，用于打开 Studio 片段菜单；片段 `Download .WAV` 经真实打包应用验证后明确设为用户本人点击，审计日志记录左右键。
- 按 Suno 新额度规则拆开三个同名流程：Premier 普通下载每月 60 次；Studio 内导出不限次数；歌曲页 `Open in Studio → Multi-track` 会拆分 stems（界面明确显示 50 credits），仍在扣费前 handoff。`Get MIDI` 同样不再误判为免费 Studio 下载。
- `browser.capture.series` / `browser.download.status` 不再默认或升级时授予所有 principal；本机维护者用 `--grant-suno-studio` 逐个授权。beta.13 v2 配置升级到 v3 时自动收回此前的批量授权。
- 打包应用真实验收：`Tragic Grandeur` 轨道截图在 5 张后以“轨道栏连续两次稳定”证明到底；`Export → Multitrack` 自动落盘 566,060,956 字节 ZIP，完整性校验通过，内含 13 条等长 WAV（含空轨）。成功记录的 `error` 字段固定为 `null`，不再误写 `"completed"`。
- beta.13 打包 smoke 改为带强断言的 beta.14 安全 smoke；修正文档中的 HTTP 路由、Suno 域名和版本锁文件。

## v0.3.0-beta.13 — 2026-09-04

- 新增 `browser.captureSeries`：Kimi 调一次即循环截图 + 落盘 + 滚动 + 到底判断；按歌建文件夹（`~/.agent-browser-local/captures/<label>-<时间戳>/shot-NN.png` + manifest.json）；scroll 加 `anchor: { kind: "coords", x, y }` 把滚轮打到内层容器，连续两次无位移即认为到底。CSS / XPath 锚点一律拒绝（安全门）。
- 新增 `browser.downloadStatus` 与 `session.on('will-download')` 接管：Suno Studio Get Stems/MIDI 直接落到 `~/Downloads/<safe-name>`，系统保存对话框不再弹出。
- `risk-policy`：Suno Studio 的 `Get Stems/MIDI` 从 credit handoff 降为 finalize 权限门（`browser.finalize.ref`）。Create Song / Remaster / Add Vocal 仍走 credit handoff，不下放。
- 旧 v2 配置自动给所有 principal 补齐 `browser.capture.series` 和 `browser.download.status` 两个新 capability（沿用 SCROLL 升级模式）。

## v0.3.0-beta.4 — 2026-08-17

- 明确禁止 Agent 自动勾选“我不是机器人”、CAPTCHA 或任何人机验证控件；检测到后只暂停并 handoff 给用户。

## v0.3.0-beta.3 — 2026-08-17

- Google/Suno 外部认证增加显式“同步认证”桥：仅从开启 CDP 的 Chrome 读取 Suno allowlist 会话 Cookie，不复制 Google Cookie，不自动解冻 Agent。
- 同步后必须由用户确认页面已回到登录态，才可继续 Agent 操作。
- 人机验证/CAPTCHA 控件新增独立 handoff 规则，Agent 不得代勾。

## v0.3.0-beta.2 — 2026-08-17

- Google/Suno 认证 URL 在 Electron 内嵌页继续前转交系统 Chrome。
- 认证转交时自动冻结 Agent 操作，避免重复扫码、内嵌 WebView 风控和登录态分裂。
- 工具栏增加“在 Chrome 中打开”重试入口；认证 URL 只保存在进程内，不写审计日志。

## v0.3.0-beta.1 — 2026-08-12

First public preview.

- Independent Electron/Chromium window with a dedicated persistent Profile.
- Loopback-only HTTP, WebSocket and MCP control surfaces for Codex, Claude, NovaGe and NovaDe.
- Daemon-owned capabilities and handoff-only confirmation policy.
- Accessibility Snapshot refs without CSS, XPath or arbitrary JavaScript APIs.
- Contribution-only platform registry and read-only collection filtering.
- Human-paced serialized actions, upload path confinement and redacted audit records.
- macOS ad-hoc packaging and isolated packaged smoke tests.

Known limitations:

- Platform-specific post-upload forms are not all live-validated.
- macOS binaries are not Developer ID signed or notarized.
- No privileged confirmation UI, automatic updates or background startup.
- Public release contains source only.

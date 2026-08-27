# Changelog

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

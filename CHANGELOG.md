# Changelog

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

# 受控下载（browser.download）设计

版本：草案 v1（feat/controlled-download）

## 背景

Agent 需要把浏览器会话内可访问的文件（带登录态/Cookie、过 Cloudflare 等反爬层的直链）逐条落盘到本机。通用 HTTP 客户端拿不到浏览器会话；而浏览器原生下载管理对 Agent 不可编程：无法感知 进行中/已完成/失败，服务器中断后重试会产生 ` (1)(2)…` 重复副本。Suno Studio 多轨导出已经用"一次性短期许可 + daemon 风险识别 + 自动落盘 + browser.downloadStatus 回报"跑通了同类问题，本功能把该模式推广为独立的受控下载原语。

## 能力边界

提供：

- `browser.download(url, savePath, overwrite?)`：在浏览器会话内对单条 URL 发起一次下载，程序可轮询 `browser.downloadStatus` 获得 `in_progress / completed / failed(含原因)` 终态。
- 失败后可由调用方重试同一 `savePath`（需显式 `overwrite: true`），落盘路径由 daemon 通过 `setSavePath` 固定，**永不产生 ` (1)` 重复副本**；目标已存在且未声明覆盖时直接报错。
- 下载中断（`interrupted`）时，若 Chromium 判定可续传（`canResume`），自动续传，最多 3 次；否则报失败由调用方决定重下。

明确不提供（与项目既有承诺一致）：

- 任意 JS evaluate、CSS/XPath 选择器、批量抓取、翻页遍历。本原语一次只处理调用方给出的一条 URL，不提供清单遍历或并发队列。
- 人机验证绕过。遇到 CAPTCHA / 403 / 下载未启动，记录失败并由 Agent 走既有 `browser.handoff` 暂停提示用户。
- 浏览器会话之外的独立 HTTP 下载（不经浏览器会话的请求一律不做）。

## 权限模型

1. **来源 allowlist**：`security.downloadSources`（config.json），origin 级白名单。登记入口集中在 `src/security/platform-registry.mjs` 的 `DOWNLOAD_REGISTRY`，首个登记项为 `musopen`（`https://musopen.org`、`https://dl.musopen.org`）。URL 必须 https、origin 精确命中、且不得解析到回环/私网地址。下载源与投稿目标（contributionTargets）是两套独立清单：登记下载源不代表开放任何页面操作。
2. **落盘根目录**：`security.downloadRoots`，与上传相同的本地路径约束思路——目标路径必须为绝对路径，其父目录 realpath 必须落在 downloadRoots 内；文件名只做 basename 校验，拒绝任何穿越。Python 适配器在调用前再把路径约束在各自 workspace 内（双保险）。
3. **principal 能力**：新增 `browser.download.file` capability，与 `browser.finalize.ref` 一样不在默认授予集内，只能由本机维护者执行 `npm run agent-permissions -- --grant-download <principal>` 授予（同时附带 `browser.download.status`），修改后重启生效。Agent 协议参数无法提权。
4. **节奏与队列**：走既有 `HumanPacedExecutor` 单队列；另设 `security.downloadMinIntervalMs`（默认 1200ms，配置下限 1000ms）强制两次受控下载之间的最小间隔，保证逐条、人类节奏。
5. **handoff 联动**：存在未决 handoff 时 `browser.download` 一律拒绝（与其他动作一致）。

## 实现要点

- daemon `browser.download` 校验后调用 `controller.controlledDownload()`，后者以"一次性待办"（按 URL 匹配、30 秒 TTL、消费即失效）挂起，再调用 `session.downloadURL(url)`；`will-download` 命中待办时 `item.setSavePath(savePath)` 接管，否则维持现有行为（Suno 许可路径 / 人工下载不动）。
- 若 15 秒内 `will-download` 未触发（例如服务器返回 403 HTML），待办过期，`browser.download` 返回失败记录，code `download_not_started`。
- 状态沿用 `controller.downloads` 表，`browser.downloadStatus` 不变即可查询（记录带 `kind: "controlled"` 与 `principal` 归属过滤）。
- 审计：JSONL 事件 `browser.download`（请求）、`browser.download.started / .completed / .failed`，字段含 `principal`、`downloadId`、`origin`+`pathname`（不含查询串）、`filename`（basename）、`receivedBytes`、`totalBytes`、`error`、`resumeAttempts`。不落盘完整 URL 查询串（可能含一次性签名）。
- 断点续传仅限同一次 `downloadItem` 生命周期内的 `resume()`；跨重试不做半截文件拼接，重试即完整重下（先删残件由 overwrite 语义控制）。

## 审计字段一览

| 字段 | 说明 |
| --- | --- |
| event | browser.download / browser.download.started / .completed / .failed |
| principal | 调用方（daemon 本地 token 映射，Agent 无权自报） |
| downloadId | `dl_<n>_<rand>` |
| url | origin + pathname，去查询串 |
| filename / savePath | basename / 受限根内绝对路径 |
| receivedBytes / totalBytes | 进度与终态字节数 |
| error | 失败原因（interrupted/cancelled/download_not_started 等） |
| resumeAttempts | 自动续传次数（≤3） |

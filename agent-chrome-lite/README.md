# Agent Browser Local

供 Codex、Claude、NovaGe、NovaDe 共用的本地独立 Chromium 浏览器。它只负责把用户自己的内容送上平台，不提供采集、爬取、列表遍历或任意 JavaScript 能力。

当前版本：`v0.3.0-beta.13`（Public Preview）。

平台入口由 `src/security/platform-registry.mjs` 统一登记。当前登记小宇宙、喜马拉雅、Suno、微信公众号、微信视频号、抖音、小红书和快手；登记只代表协议层知道投稿入口，不代表 Agent 可以登录、同意协议或执行最终发布。Suno 仅保留适配定义，默认不启用。

网易云音乐已记录在 `PLATFORM_BACKLOG`，但尚未进入 allowlist。正式启用前必须核验官方创作者入口、登录跳转和最终人工发布门。

> Beta 边界：浏览器内核、四 Agent 接入与安全门已经可运行；各平台上传后的二阶段表单仍在逐项验收。不要把本预览版当作无人值守发布器。

## 已实现

- Electron/Chromium 独立窗口与独立 Profile，不读取日常 Chrome 数据。
- 所有受控页面都按不可信输入处理：sandbox、权限全拒绝、`webSecurity`、安全弹窗和统一网络出口同时生效。
- 受控页面不能探测 daemon、loopback、私网、`file:` 或带账号密码的 URL；普通外部登录页进入前即触发 handoff，Google/Suno 认证 URL 会在请求继续前转交系统 Chrome。
- renderer 崩溃、页面无响应、主框架加载失败或 CDP 超时只会把当前页面标为故障并冻结自动化；daemon 与登录 Profile 保留，不自动重建或反复登录。
- Snapshot-first：通过 Chromium Accessibility/CDP 生成短期 `ref`，不向 Agent 暴露 CSS/XPath；评论、统计和记录型内容不进入 Snapshot。
- `ref` 在每次动作、刷新或导航后失效。
- 无名控件允许“当前截图动态定位”；截图 ID 60 秒过期，页面变化立即失效，禁止固定坐标。
- 投稿页提供受权限控制的 `browser.scroll`：支持有限的人类步长，也支持最多 12 步、逐步节流的 `bottom`；只读取视口几何，不读取或导出页面正文，方向/步幅进入审计。普通文档能可靠回报 `reachedEnd`；SPA 内层滚动容器无法从文档几何证明到底时会返回 `false`，由下一张截图复核，禁止假报成功。
- `browser.captureSeries` 把滚动截屏拆成一连串可视化证据：daemon 循环截图 → 落盘到 `~/.agent-browser-local/captures/<label>-<timestamp>/shot-NN.png` → 按歌建文件夹，每歌自动命名；scroll 通过 `{ anchor: { kind: "coords", x, y } }` 把滚轮锚点打到 Suno Studio 左侧内层轨道面板，连续两次无位移即认为到底。每张截图的 pageY / viewportHeight / URL 都写进 `manifest.json`，方便 Agent 复核位置；不再拼长图、不再顺手整理笔记。
- `session.on('will-download')` 接管 Suno Studio 的 stem / MIDI 下载：写文件直接落到 `~/Downloads/<safe-name>`，系统保存对话框不再弹出；`browser.downloadStatus` 返回当前在飞 / 已完成的下载记录（含 savePath、bytes、状态），用于 Kimi 校验"今天到底下到哪几轨"。
- 文件上传通过 Snapshot 找到原生文件输入；隐藏输入可从语义上传入口或 60 秒有效的当前截图动态按钮拦截 file chooser、核验最终原生节点，再调用 CDP `DOM.setFileInputFiles`。
- 本地 daemon 只监听 `127.0.0.1`，HTTP/WS 均由 bearer token 认证。
- principal、capabilities、confirmation policy 全部来自 daemon 本地配置；Agent 无权自报。
- 创删、提交和发布默认由 daemon 拦截；只有本地权限表明确授予 `browser.finalize.ref` 的 principal 才能代为执行，并逐次写入审计。删除、支付、登录、验证码、Suno Create 仍不可委托。
- Suno Studio 的 `Get Stems/MIDI` 不再走 credit handoff：按 2026-09 Suno ToS Studio 下载为 approved channel（不限量），降为 finalize 权限门；本机维护者可向指定 principal 授予 `browser.finalize.ref` 以代点下载，按钮仍按 risk-policy 触发需要 finalize 的代码路径并逐次写入审计。
- 人机验证、CAPTCHA、“我不是机器人”和类似安全检查永远由用户本人完成；Agent 只负责识别、暂停和提示，不会自动勾选或尝试绕过。
- 单队列、人类节奏执行和 JSONL 审计。
- MCP stdio 薄适配器；NovaGe/NovaDe 可直接调用 HTTP。
- NovaGe/NovaDe 共用 `adapters/python/agent_browser_client.py`；principal 固定为本机 token 映射，服务地址只能是 loopback，上传文件只能来自各自 workspace。
- macOS 单实例锁：重复双击只唤醒已运行窗口，不创建第二个 daemon 或第二套 Profile。
- 启动失败会显示本地错误窗口；页面故障会在工具栏显示红色状态，同时明确保留登录资料。
- Google/Suno 登录不会在 Electron 内嵌窗口里反复尝试：检测到认证弹窗或主框架认证跳转时，自动打开系统 Chrome，并冻结当前页面。完成登录后，需在 Chrome 保留 Suno 页面并点击“完成后同步认证”；桥只读取 Suno allowlist 会话 Cookie，刷新 Agent Browser 页面，最后由用户确认“我已接管”。同步需要 Chrome 远程调试端点（默认 `http://127.0.0.1:9222`，可用 `ABL_CHROME_CDP_URL` 覆盖），不会读取 Google Cookie，也不会复制整个 Chrome Profile。

## 明确不提供

- 任意 JavaScript / DOM evaluate。
- CSS、XPath 或 test-id 选择器接口。
- HTML/正文导出、网络拦截、翻页遍历、批量抓取。
- 读取型后台路径（评论、分析、统计、订阅、收益等）的导航与截图。
- Agent 自行申请或自报代发布权限。`browser.finalize.ref` 只能由本机维护者写入本地 principal 配置。

## 启动

```bash
git clone https://github.com/oracle9i88/agent-browser-local.git
cd agent-browser-local
npm ci
npm start
```

也可以双击本地构建产物：`dist/Agent Browser Local.app`。该应用使用 ad-hoc 本地签名，适合当前机器自用，尚未做 Apple Developer ID 公证。

## macOS 打包

```bash
npm run package:mac
npm run test:packaged
```

`package:mac` 使用项目现有 Electron 运行时离线生成 `.app`、版本化 ZIP 和 `release-manifest.json`，不下载新依赖；只打入运行所需的 `src/` 与 `ws`。应用有独立名称、Bundle ID 和图标，并删除 Electron 模板的摄像头、麦克风、蓝牙及任意网络加载权限声明。发布清单记录 ZIP 字节数和 SHA-256。

`test:packaged` 使用 `/tmp` 临时 Profile、随机 loopback 端口和 `about:blank` 启动隐藏应用；随后启动第二份验证单实例锁，再检查四个固定 principal。它不读取正式 Profile，也不打开账号页面。

无需启动浏览器即可运行本机体检：

```bash
npm run doctor
```

体检只读取配置元数据，不读取 token 内容；它检查配置/token 权限、Profile 是否存在、daemon 是否安全监听，以及 `.app`、ZIP 和发布清单哈希是否一致。daemon 未运行会如实显示，但不会因此启动它。

首次启动会创建：

- 配置：`~/.agent-browser-local/config.json`
- Agent token：`~/.agent-browser-local/tokens.env`（仅当前用户可读）
- 独立 Profile：`~/.agent-browser-local/profile`
- 审计：`~/.agent-browser-local/audit/events.jsonl`

首次生成的 Codex、Claude、NovaGe、NovaDe token 写入权限为 `0600` 的 `tokens.env`；daemon 配置本身仅保存 SHA-256。

## HTTP 示例

```bash
export ABL_TOKEN='首次启动显示的 token'

curl -H "Authorization: Bearer $ABL_TOKEN" \
  http://127.0.0.1:3767/v1/session

curl -X POST \
  -H "Authorization: Bearer $ABL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"url":"https://podcaster.xiaoyuzhoufm.com/podcast/YOUR_PODCAST_ID"}' \
  http://127.0.0.1:3767/v1/navigate

curl -X POST \
  -H "Authorization: Bearer $ABL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{}' \
  http://127.0.0.1:3767/v1/snapshot

curl -X POST \
  -H "Authorization: Bearer $ABL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"direction":"down","amount":"bottom"}' \
  http://127.0.0.1:3767/v1/actions/scroll

# 滚动截屏：按歌建文件夹，自动滚到底或 maxShots 为止
curl -X POST \
  -H "Authorization: Bearer $ABL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"label":"Tragic Grandeur","anchor":{"kind":"coords","x":0.2,"y":0.5},"maxShots":12}' \
  http://127.0.0.1:3767/v1/actions/captureSeries

# 下载进度查询（Kimi 校验今天到底下到哪几轨）
curl -X POST \
  -H "Authorization: Bearer $ABL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{}' \
  http://127.0.0.1:3767/v1/actions/downloadStatus
```

WebSocket 地址为 `ws://127.0.0.1:3767/v1/ws`，认证放在 `Authorization: Bearer ...` 请求头里。消息格式：

```json
{"id":"1","method":"browser.snapshot","params":{}}
```

## Suno Studio 工作流（agent 验收）

Suno Studio 的滚动截屏和 stem 下载不是普通页面交互；下面的步骤是 Kimi 在 `podcaster.suno.com` 上做滚动截屏 + 下载分轨的官方做法，任何一步跳过都会让 captureSeries / downloadStatus 返回不可信结果。

1. **登录与 dismiss**：首次进 Suno Studio 时右下角会浮出 "What's This?" 帮助层，必须先由用户本人点 Dismiss（Agent 不代勾也不会自动隐藏）。Dismiss 后浮层消失，左侧轨道面板才进入完整滚动模式。
2. **滚动截屏**：`browser.captureSeries` 必传 `anchor: { kind: "coords", x: 0.18, y: 0.5 }`（约 Studio 左侧面板中段）；`label` 由 Kimi 看第一屏截图读出歌名后传入，写入 `~/.agent-browser-local/captures/<label>-<时间戳>/shot-NN.png`。
3. **下载分轨**：每个 clip 左上角的设置小图标触发 Get Stems，按钮被 risk-policy 识别为 `stem_download_requires_finalize`。只有本地权限表授予 `browser.finalize.ref` 的 principal 能代点下载；本机维护者用 `npm run agent-permissions -- --grant-finalize <principal>` 一次性授权。下载直接落到 `~/Downloads/`，下载完成时间由 `browser.downloadStatus` 报告。
4. **复核位置**：manifest.json 里每屏的 pageY / viewportHeight / URL 都记下来；如果最后一屏 pageY 接近 viewportHeight 而 stopReason 不是 `reached_end`，说明到底判断失败，应让 Kimi 重跑一次或换 anchor 坐标。

## MCP

Claude Code 与 Codex 使用同一个 stdio 入口：

```bash
export PROJECT_DIR="/absolute/path/to/agent-browser-local"
ABL_TOKEN='对应 principal 的 token' \
node "$PROJECT_DIR/mcp/server.mjs"
```

工具只有：status、navigate、snapshot、有限步长 scroll、click/ref、fill/ref、upload/ref、当前截图、截图动态点击和 handoff。发布仍复用短期 Snapshot `ref`；是否允许执行由 daemon 本地 `browser.finalize.ref` capability 决定，协议参数不能提权。

不把 token 写进 MCP 配置的固定 principal 启动方式见 [config/MCP-SETUP.md](config/MCP-SETUP.md)。

## 检查

```bash
npm run check
npm test
npm run test:upload
npm run test:chromium-gold
npm run test:protocols
npm run test:python
```

`test:upload` 与 `test:chromium-gold` 指向同一个真实 Chromium 金样：验证原生/语义上传、富文本多段落和链接保真、刷新后语义重新发现、旧 ref 失效、只投稿 Snapshot 隐私边界，以及同一 fixture 的确定性渲染。

`test:protocols` 在随机 loopback 端口启动隔离 daemon，验证真实 HTTP、WebSocket 和 MCP 链，不连接正在登录的平台浏览器。`test:python` 验证 NovaGe/NovaDe 的固定 principal HTTP 适配器。

已有独立 Profile 要新增平台入口时，由本机维护者显式执行（Agent 协议没有修改权限表的工具）：

```bash
npm run platforms -- --list
npm run platforms -- ximalaya
npm run platforms -- --disable suno
```

代发布权限同样只能由本机维护者管理，修改后重启应用生效：

```bash
npm run agent-permissions -- --list
npm run agent-permissions -- --grant-finalize codex
npm run agent-permissions -- --revoke-finalize codex
```

## 发布状态

- Git tag：`v0.3.0-beta.13`（验收通过后创建）
- GitHub：`codex/scroll-beta12` 保存本版源码；tag 在打包和验收通过后固定审计提交。
- 本地 macOS 包仍为 ad-hoc 签名；没有 Developer ID 公证，不作为公开二进制分发。
- 安全问题请按 [SECURITY.md](SECURITY.md) 使用 GitHub Private Vulnerability Reporting 提交，避免在公开 Issue 中粘贴 token、Profile、账号页面或审计日志。

本仓库当前未声明开源许可证。公开可见不等于获得复制、修改或再分发授权；许可证将在稳定版前另行确定。

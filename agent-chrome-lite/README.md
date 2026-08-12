# Agent Browser Local

供 Codex、Claude、NovaGe、NovaDe 共用的本地独立 Chromium 浏览器。它只负责把用户自己的内容送上平台，不提供采集、爬取、列表遍历或任意 JavaScript 能力。

当前版本：`v0.3.0-beta.1`（Public Preview）。

平台入口由 `src/security/platform-registry.mjs` 统一登记。当前登记小宇宙、喜马拉雅、Suno、微信公众号、微信视频号、抖音、小红书和快手；登记只代表协议层知道投稿入口，不代表 Agent 可以登录、同意协议或执行最终发布。Suno 仅保留适配定义，默认不启用。

网易云音乐已记录在 `PLATFORM_BACKLOG`，但尚未进入 allowlist。正式启用前必须核验官方创作者入口、登录跳转和最终人工发布门。

> Beta 边界：浏览器内核、四 Agent 接入与安全门已经可运行；各平台上传后的二阶段表单仍在逐项验收。不要把本预览版当作无人值守发布器。

## 已实现

- Electron/Chromium 独立窗口与独立 Profile，不读取日常 Chrome 数据。
- 所有受控页面都按不可信输入处理：sandbox、权限全拒绝、`webSecurity`、安全弹窗和统一网络出口同时生效。
- 受控页面不能探测 daemon、loopback、私网、`file:` 或带账号密码的 URL；外部登录页可以显示，但进入前即触发 handoff。
- renderer 崩溃、页面无响应、主框架加载失败或 CDP 超时只会把当前页面标为故障并冻结自动化；daemon 与登录 Profile 保留，不自动重建或反复登录。
- Snapshot-first：通过 Chromium Accessibility/CDP 生成短期 `ref`，不向 Agent 暴露 CSS/XPath；评论、统计和记录型内容不进入 Snapshot。
- `ref` 在每次动作、刷新或导航后失效。
- 无名控件允许“当前截图动态定位”；截图 ID 60 秒过期，页面变化立即失效，禁止固定坐标。
- 文件上传通过 Snapshot 找到原生文件输入；隐藏输入则从语义上传入口拦截 file chooser、核验最终原生节点，再调用 CDP `DOM.setFileInputFiles`。
- 本地 daemon 只监听 `127.0.0.1`，HTTP/WS 均由 bearer token 认证。
- principal、capabilities、confirmation policy 全部来自 daemon 本地配置；Agent 无权自报。
- 创建、发布、提交、删除、支付、登录、验证码、协议确认、Suno Create、Get Stems/MIDI 等动作在发出前由 daemon 拦截并 handoff。
- 单队列、人类节奏执行和 JSONL 审计。
- MCP stdio 薄适配器；NovaGe/NovaDe 可直接调用 HTTP。
- NovaGe/NovaDe 共用 `adapters/python/agent_browser_client.py`；principal 固定为本机 token 映射，服务地址只能是 loopback，上传文件只能来自各自 workspace。
- macOS 单实例锁：重复双击只唤醒已运行窗口，不创建第二个 daemon 或第二套 Profile。
- 启动失败会显示本地错误窗口；页面故障会在工具栏显示红色状态，同时明确保留登录资料。

## 明确不提供

- 任意 JavaScript / DOM evaluate。
- CSS、XPath 或 test-id 选择器接口。
- HTML/正文导出、网络拦截、翻页遍历、批量抓取。
- 读取型后台路径（评论、分析、统计、订阅、收益等）的导航与截图。
- P0 特权确认接口。最终动作只能由用户在浏览器窗口中亲自完成。

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
```

WebSocket 地址为 `ws://127.0.0.1:3767/v1/ws`，认证放在 `Authorization: Bearer ...` 请求头里。消息格式：

```json
{"id":"1","method":"browser.snapshot","params":{}}
```

## MCP

Claude Code 与 Codex 使用同一个 stdio 入口：

```bash
export PROJECT_DIR="/absolute/path/to/agent-browser-local"
ABL_TOKEN='对应 principal 的 token' \
node "$PROJECT_DIR/mcp/server.mjs"
```

工具只有：status、navigate、snapshot、click/ref、fill/ref、upload/ref、当前截图、截图动态点击和 handoff。没有发布或确认工具。

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

## 发布状态

- Git tag：`v0.3.0-beta.1`
- GitHub Release：Pre-release，仅发布源码。
- 本地 macOS 包仍为 ad-hoc 签名；没有 Developer ID 公证，不作为公开二进制分发。
- 安全问题请按 [SECURITY.md](SECURITY.md) 使用 GitHub Private Vulnerability Reporting 提交，避免在公开 Issue 中粘贴 token、Profile、账号页面或审计日志。

本仓库当前未声明开源许可证。公开可见不等于获得复制、修改或再分发授权；许可证将在稳定版前另行确定。

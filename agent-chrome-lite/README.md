# Agent Browser Local

供 Codex、Claude、NovaGe、NovaDe 共用的本地独立 Chromium 浏览器。它只负责把用户自己的内容送上平台，不提供采集、爬取、列表遍历或任意 JavaScript 能力。

当前代码：`v0.3.0-beta.18` 候选版（喜马拉雅嵌入页发布按钮待真实账号验收）。已有上传二阶段表单验收见 `../BROWSER-AGENT-XIMALAYA-VALIDATION-2026-09-06.md`。

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
- `browser.captureSeries` 只在 Suno Studio 可用，并要求来自 60 秒内当前截图的视觉锚点；daemon 循环保存完整截图并滚动，以左侧轨道编号/名称栏的裁剪哈希判断进度，排除 Magic Bar 轮换提示等动画干扰。连续两次轨道栏不变才报告到底。截图写入 `~/.agent-browser-local/captures/<label>-<timestamp>/`，manifest 同时记录完整图片哈希、稳定判定哈希和不含查询串的页面地址。
- Suno Studio 多轨本机导出使用一次性、15 秒短期许可：只有经 daemon 风险策略识别并审计的 `Export → Multitrack` 才能触发自动落盘；普通歌曲页 Download 不使用这条通道。片段 `Download .WAV` 及其系统保存流程由用户本人完成。`browser.downloadStatus` 返回 Agent 发起的多轨在飞/已完成记录。
- 文件上传通过 Snapshot 找到原生文件输入；隐藏输入可从语义上传入口或 60 秒有效的当前截图动态按钮拦截 file chooser、核验最终原生节点，再调用 CDP `DOM.setFileInputFiles`。
- 本地 daemon 只监听 `127.0.0.1`，HTTP/WS 均由 bearer token 认证。
- principal、capabilities、confirmation policy 全部来自 daemon 本地配置；Agent 无权自报。
- 创删、提交和发布默认由 daemon 拦截；只有本地权限表明确授予 `browser.finalize.ref` 的 principal 才能代为执行，并逐次写入审计。删除、支付、登录、验证码、Suno Create 仍不可委托。
- Suno 的额度语义按页面实际信息区分：Premier 普通歌曲页下载每月 60 次；已进入 Studio 后的导出不限次数；歌曲页 `Open in Studio → Multi-track` 若明确显示 50 credits，则按本地 `browser.credits.suno` 权限执行。Studio 的 `Get Stems / MIDI` 不再凭按钮名称额外强制 handoff；只有页面节点明确标出 credits 时，才进入同一额度权限规则。
- 人机验证、CAPTCHA、“我不是机器人”和类似安全检查永远由用户本人完成；Agent 只负责识别、暂停和提示，不会自动勾选或尝试绕过。
- 单队列、人类节奏执行和 JSONL 审计。
- MCP stdio 薄适配器；NovaGe/NovaDe 可直接调用 HTTP。
- NovaGe/NovaDe 共用 `adapters/python/agent_browser_client.py`；principal 固定为本机 token 映射，服务地址只能是 loopback，上传文件只能来自各自 workspace。
- macOS 单实例锁：重复双击只唤醒已运行窗口，不创建第二个 daemon 或第二套 Profile。
- 启动失败会显示本地错误窗口；页面故障会在工具栏显示红色状态，同时明确保留登录资料。
- Google/Suno 登录不会在 Electron 内嵌窗口里反复尝试：迁移向导可打开使用独立持久 Profile 的 Chrome 会话桥；用户只在该 Chrome 完成 Google 登录，随后逐域授权 `suno.com` 与 `auth.suno.com` 同步。桥只读取 Suno/Clerk 最小白名单 Cookie，Google Cookie、密码、整份 Chrome Profile 均不读取。同步后程序必须以页面出现 Profile menu/credits 且 Log in 消失作为真实验收；仅有“Cookie 已注入”不能判定登录成功。

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
npm run test:capture
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
  --data '{"label":"Tragic Grandeur","anchor":{"kind":"visual","screenshotId":"CURRENT_SCREENSHOT_ID","x":230,"y":430},"maxShots":12}' \
  http://127.0.0.1:3767/v1/actions/capture-series

# 下载进度查询（Kimi 校验今天到底下到哪几轨）
curl -X POST \
  -H "Authorization: Bearer $ABL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{}' \
  http://127.0.0.1:3767/v1/actions/download-status
```

WebSocket 地址为 `ws://127.0.0.1:3767/v1/ws`，认证放在 `Authorization: Bearer ...` 请求头里。消息格式：

```json
{"id":"1","method":"browser.snapshot","params":{}}
```

## Suno Studio 工作流（agent 验收）

Suno Studio 的滚动截屏和多轨下载不是普通页面交互；下面是 Agent 在 `https://suno.com/studio` 上执行滚动截屏和下载的受限流程。

1. **登录与 dismiss**：首次进 Suno Studio 时右下角会浮出 "What's This?" 帮助层，必须先由用户本人点 Dismiss（Agent 不代勾也不会自动隐藏）。Dismiss 后浮层消失，左侧轨道面板才进入完整滚动模式。
2. **滚动截屏**：先调用 `browser.screenshot`，再从这张截图选择左侧轨道面板内一点，把同一 `screenshotId` 和像素坐标作为 `kind: visual` 锚点传给 `browser.captureSeries`。视觉锚点 60 秒过期，页面变化即失效，禁止保存固定坐标复用。
3. **进入多轨工程**：从歌曲页选择 `Edit → Open in Studio → Multi-track`；当选择项显示 stems 与 credits 时，daemon 必须在扣费前 handoff 给用户确认。进入 Studio 后才能做配器截图。
4. **下载工程**：Studio 中的 `Export → Multitrack` 下载全部轨道，并被识别为 `studio_download_requires_finalize`；只有本地权限表授予 `browser.finalize.ref` 的 principal 能代点。要快速取单轨/片段，Agent 可用 `browser.click` / `browser.clickVisual` 的 `mouseButton: "right"` 打开片段菜单，但 `Download .WAV` 和随后出现的系统保存流程不由应用自动落盘（无一次性许可时 `will-download` 故意不接管）。Agent 不把这条流程假报为应用内自动下载；实际可由 Agent 通过 macOS 辅助功能按键确认系统保存框（见下节）。多轨自动下载落到 `~/Downloads/`，并由 `browser.downloadStatus` 监控。`Full Song` / `Selected Time Range` 只存回 Library，不算本机下载。
5. **复核位置**：只有 `stopReason=visual_stable_after_two_scrolls` 才代表视觉证据支持已经到底；`max_shots` 代表未能证明到底，不得假报完成。

## Suno 歌曲页下载流程（agent 验收，2026-09-05）

Premier 普通歌曲页下载计入每月额度（对话框底部显示 Plan / Downloads 剩余数 / Refreshes 日期）；一首歌首次解锁消耗一次额度，之后可随时重下。以下流程已在真实账号跑通（D Minor Lament：M4A 3.0MB opus 166.7s + WAV 32MB PCM 48kHz 166.9s，RMS 验证非静音）：

1. 从 Library 进入目标歌曲页。
2. 点**歌曲本体的 ⋯ 菜单**（紧邻 Edit Song Details / Download Cover Image 的那个 More menu contents；菜单含 Publish / Report / Move to Trash）。不要点底部播放条的 ⋯——播放条里是上一首播放的歌，对话框标题不会变，极易下错。
3. Download → 格式对话框：M4A / MP3 / WAV / MP4 video asset 是**多选**，默认只勾 M4A。点 WAV 是加勾，必须再点 M4A 取消，并用截图复核只剩 WAV。
4. 首次下载按钮为 `Unlock & Download`（消耗一次额度）；已解锁的歌为 `Download`。
5. 服务器转码期间按钮显示 `Preparing...`（实测约 30–90 秒），完成后弹出 macOS 系统保存 sheet。
6. 保存 sheet 不在页面 DOM 内，应用按设计不接管（无一次性许可时 `will-download` 不静默落盘）。最后一下由 Agent 通过 macOS 辅助功能完成：

```bash
osascript -e 'tell application "Agent Browser Local" to activate' \
  -e 'delay 1.5' \
  -e 'tell application "System Events" to keystroke return'
```

前提是运行 Agent CLI 的终端宿主（本机为 iTerm）已在 系统设置 → 隐私与安全性 → 辅助功能 中授权。同名文件已存在时还会弹"替换/取消"（sheet 里嵌套一层 sheet），需点"替换"。

7. 验收：检查落盘文件的格式与时长，并采样 RMS 确认非静音——空 Studio 工程会导出全静音 WAV（"Untitled Project" 实测 180s 全 0），下载前先确认歌曲有声音。

已知坑：全静音歌曲的 M4A 是 27KB 空壳；Suno 的 M4A 实为 opus 封装，afinfo/afconvert 读不了，须用 ffprobe/ffmpeg 验证。

## Suno 多轨 Studio 下载流程（agent 验收，2026-09-06）

整首歌进 Studio 分轨再整包下载，**不消耗每月 66 首额度**（实测 10 首连下后额度不变）。每首流程：

1. 歌曲页 → 歌曲本体 ⋯ 菜单 → 视觉点击 `Edit ▸` **两次**（第一次高亮、第二次才展开子菜单）→ `Open in Studio`（子菜单倒数第二项）。
2. 弹窗选 `Single-track`（整混，免费）或 `Multi-track`（分轨，50 credits；标注价格，需 `browser.credits.suno` 能力方可委托）。分轨需 1–6 分钟，期间可能弹 Cloudflare 人机验证——**不用管，5–6 分钟自行消失**，分轨继续。人机验证本身永远不许 Agent 代勾。
3. 多轨工程打开后先 `browser.captureSeries` 截屏（锚点取左侧轨道面板 (140,200)），`reachedEnd=true` 才算截全。
4. `Export menu → Multitrack`（finalize 可委托，一次性许可自动落盘 ZIP 到 ~/Downloads）。**首次导出常 0 字节 interrupted**（服务器还在打包），重试一次即正常传输；大 ZIP 300–600MB。
5. 验收：`unzip -t` 完整性 + 主轨 WAV 用 `unzip -p … | ffmpeg -i pipe:0 -af volumedetect` 看电平（float32 WAV，Python wave 库读不了）。

已知坑：
- 从 /studio 导航回 /create 或 /me 经常"假成功"（URL 不变），需再导一次；列表行要等 5–10 秒才进 a11y 树。
- 长时间连续操作后页面可能 CDP 超时冻结（今晚三次），重启应用即恢复，Profile 和 Studio 工程都不丢（工程在服务端，重开 /studio 自动回到最近工程）。
- Create 表单：生成后 Styles 自动清空、Exclude styles 和标题保留；换提示词必须先 `Clear all form inputs`（有 Confirm 确认框）再填，否则标题会追加串联。视觉填写（fillVisual）60 秒截图过期，截图和填写要连着做。
- 多轨 ZIP 命名冲突时自动加 (2)/(3) 后缀；监视脚本误判会重复下载同歌，完成后人工核对去重。

## 迁移到新机器

1. `git clone` 本仓库 → `npm ci` → `npm start`（或 `npm run package:mac` 后双击 dist 里的 .app）。
2. 首次启动生成 `~/.agent-browser-local/`（config.json、tokens.env、profile、audit）。
3. Suno 登录走 Chrome 会话桥迁移向导；以页面出现 Profile menu/credits、Log in 消失为验收。
4. 系统设置 → 隐私与安全性 → 辅助功能：给运行 Agent CLI 的终端 App（如 iTerm）授权，否则无法确认系统保存框。
5. `npm run doctor` 体检通过后，即可按上两节流程下载与截图。

## MCP

Claude Code 与 Codex 使用同一个 stdio 入口：

```bash
export PROJECT_DIR="/absolute/path/to/agent-browser-local"
ABL_TOKEN='对应 principal 的 token' \
node "$PROJECT_DIR/mcp/server.mjs"
```

工具包括 status、navigate、snapshot、有限步长 scroll、click/ref、fill/ref、upload/ref、当前截图、截图动态点击、喜马拉雅嵌入页发布检查/单次点击和 handoff。常规发布仍复用短期 Snapshot `ref`；是否允许执行由 daemon 本地 `browser.finalize.ref` capability 决定，协议参数不能提权。

喜马拉雅上传页的跨域嵌入表单有专用的非破坏性检查 `POST /v1/actions/ximalaya-publish-check`。确定目标专辑、AI 声明、分类和上传状态正确后，具有本地代发布权限的 principal 才可调用 `POST /v1/actions/ximalaya-publish` **一次**。接口在嵌入页按 AX 名称唯一定位「确认发布」，重新读取按钮几何位置，并向子页面发送 CDP 鼠标事件；外壳、嵌入页和按钮不符合预期则拒绝。返回值只代表点击派发，不代表发布成功；在同一上传表单上禁止二次点击。按 [喜马拉雅发布 skill](skills/ximalaya-publish/SKILL.md) 验证节目是否真的进入「审核中」或「已发布」。

不把 token 写进 MCP 配置的固定 principal 启动方式见 [config/MCP-SETUP.md](config/MCP-SETUP.md)。

## 检查

```bash
npm run check
npm test
npm run test:upload
npm run test:chromium-gold
npm run test:frame-gold
npm run test:protocols
npm run test:python
```

`test:upload` 与 `test:chromium-gold` 指向同一个真实 Chromium 金样：验证原生/语义上传、富文本多段落和链接保真、刷新后语义重新发现、旧 ref 失效、只投稿 Snapshot 隐私边界，以及同一 fixture 的确定性渲染。

`test:frame-gold` 使用两张临时本机网页验证跨域子页面独立 CDP 会话、AX 按钮和固定底栏真实鼠标事件，不连接喜马拉雅账号。

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
npm run agent-permissions -- --grant-suno-studio codex
npm run agent-permissions -- --revoke-suno-studio codex
```

## 发布状态

- 最近已验证 tag：`v0.3.0-beta.17`；`beta.18` 当前仅为候选代码，真实喜马拉雅发布验收后再打 tag。
- GitHub：`codex/scroll-beta12` 保存候选源码；tag 在打包和验收通过后固定审计提交。
- 本地 macOS 包仍为 ad-hoc 签名；没有 Developer ID 公证，不作为公开二进制分发。
- 安全问题请按 [SECURITY.md](SECURITY.md) 使用 GitHub Private Vulnerability Reporting 提交，避免在公开 Issue 中粘贴 token、Profile、账号页面或审计日志。

本仓库当前未声明开源许可证。公开可见不等于获得复制、修改或再分发授权；许可证将在稳定版前另行确定。

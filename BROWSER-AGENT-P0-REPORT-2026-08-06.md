# Agent Browser Local：P0 实施报告

日期：2026-08-06；2026-08-07 更新  
项目：`/Users/evanguo/Documents/New project2/agent-chrome-lite`  
结论：**P0 通用浏览器内核和四 Agent 接入已可运行；小宇宙正式单集上传尚未执行，喜马拉雅已完成登录门、投稿入口和可重新发现性验收，但尚未选择正式音频，因此不能宣称整项交付完成。**

## 已完成

### 0.3.0：Kitesurf 架构借鉴（不更换 Chromium）

- 保留本地 Electron/Chromium、独立持久 Profile 和真实窗口；不采用 Kitesurf 作为账号平台地基，因为投稿流程依赖持久登录、文件上传与人工接管。
- 所有受控 WebContents 统一登记到 session 级网络出口策略。平台自身及 CDN 的远程资源可以加载；页面对 loopback、私网、本地域名、`file:`、危险协议和 URL 内嵌凭证的请求会在发出前取消。
- 主框架跳出投稿 allowlist 时仍允许用户完成外部登录，但在网络请求阶段立即 handoff，Agent 不得继续动作。
- renderer 崩溃、页面无响应、主框架加载失败和 CDP 命令超时均进入显式 `pageHealth=faulted`；Snapshot、截图和动作 fail closed，daemon 与登录 Profile 保留，不自动重建会话。
- 原 Electron 上传金样升级为 Chromium 合同测试：同一临时 Profile 本地 fixture 同时验证语义字段、Show Notes 多段落/空行/链接读回、只投稿隐私过滤、刷新后新 Snapshot/ref、原生与语义上传，以及重新进入前后的渲染哈希一致。
- 新金样发现并修复了混合根文本与块级节点的富文本序列化缺陷；此前真实小宇宙编辑器能通过，但最小 Chromium contenteditable 会漏掉第一段，现已由金样冻结。

### 独立浏览器与控制本体

- Electron/Chromium 独立窗口，profile 位于 `~/.agent-browser-local/profile`，不读取日常 Chrome。
- daemon 仅监听 `127.0.0.1:3767`；HTTP 与 WebSocket 均要求 bearer token。
- Snapshot 从 Chromium Accessibility tree 生成短期 ref；动作、导航、刷新后旧 ref 失效。
- 不暴露 CSS、XPath、任意 JavaScript、HTML 导出、列表遍历、网络拦截或抓取能力。
- 动态视觉降级绑定当前截图 ID，60 秒或页面变化后失效。
- 所有动作串行并按人的节奏节流；写入 JSONL 审计，填写内容只记录长度与哈希。

### 权限与安全门

- Codex、Claude、NovaGe、NovaDe 的 principal、capabilities 和 `handoff-only` 策略由 daemon 本地 token 映射决定。
- Agent 请求无法自报或提高权限。
- 登录、密码、验证码、协议同意、创建、提交、发布、删除、支付和 credits 动作均在浏览器发出动作前阻断。
- handoff 存在时，除状态读取与 handoff 本身外，所有自动化冻结，必须由用户在浏览器 UI 清除。
- 后台首页 Snapshot 会过滤评论、统计、分析和记录型链接/按钮；只有贡献表单才返回表单提示。`/interaction`、`/data-analysis`、`/stats`、`/subscriber`、`/profit` 等读取型路径也在 contribution policy 层直接拒绝，落实“只添加、不采集”。
- 平台投稿入口集中登记在可审计 registry；现有本机配置已加入喜马拉雅和视频号的精确投稿路径，Agent 协议本身没有修改 registry 或权限表的工具。

### 文件上传

- 可直接将 Snapshot 发现的原生 file input 映射到 `backendDOMNodeId` 并调用 `DOM.setFileInputFiles`。
- 对隐藏 file input，Snapshot 把“点击上传”语义节点生成临时 upload ref；执行时拦截 file chooser、核验最终节点确实为原生 `input[type=file]`，再绑定文件。
- Electron 金样同时通过上述两条路径，没有退回 CSS/XPath。

### Agent 接入

- Codex：全局 MCP `agent-browser` 已登记并启用，固定读取 Codex principal token。
- Claude Code：用户级 MCP `agent-browser` 已登记，健康检查显示 connected，固定读取 Claude principal token。
- NovaGe：正式 `/Users/evanguo/claude/novage/agent.py` 已增加 `agent_browser` HTTP 工具。
- NovaDe：正式 `/Users/evanguo/claude/novade/agent.py` 已增加 `agent_browser` HTTP 工具。
- 2026-08-07 复查发现两者共同导入的 Python 客户端文件此前缺失，工具会静默返回“Adapter 未安装”；现已补齐 `agent-chrome-lite/adapters/python/agent_browser_client.py`，无需复制到两个 Agent 目录。客户端只接受 `novage`/`novade` 固定 principal、只连 loopback、上传文件仅限各自 workspace。
- MCP 只暴露九个工具：status、navigate、snapshot、click、fill、upload、screenshot、visual click、handoff。

## 小宇宙真页面结果

在独立 profile 登录后，以“听懂古典音乐”的创建单集页验证：

- 页面重启和重新进入后产生全新 refs，并重新发现：
  - `在这里编辑 Show Notes`
  - `输入单集标题`
  - 音频 `点击上传`
  - 封面 `点击上传封面`
  - 协议复选框
  - submit 类型的“创建”按钮
- Show Notes 输入与读回完全一致：

```text
第一段：Snapshot G0 保真测试。

第二段：换行与链接测试。
https://example.com/g0-check
```

- 未上传任何文件到真实账号。
- 未勾协议，未点击创建。
- 测试文字已清空，随后重启独立浏览器丢弃未保存编辑状态；当前浏览器回到空白页，登录 profile 保留。

## 喜马拉雅真页面结果

- 官方官网上传入口 `www.ximalaya.com/reform-upload/page/upload` 最终落到 `studio.ximalaya.com/upload`；未登录时跳到 `passport.ximalaya.com`，daemon 根据最终 URL 自动 handoff 并冻结全部 Agent 操作。
- 用户本人扫码登录后，浏览器回到允许的 `/upload`，handoff 自动解除。
- 初次真页面 Snapshot 发现语义上传入口，同时暴露了内容管理、互动管理、数据中心和收益等读取型按钮；没有点击这些按钮，随即将其补入 Snapshot 层过滤规则。
- 修复后 Snapshot 只留下投稿相关的“上传、内容创作、创建专辑”；内容管理、互动管理、数据中心、直播管理、作品推广、创作收益等不再进入 Agent 视图。
- 连续两次重新进入 `/upload`，分别生成 `f242ea1b` 与 `00ae3a7b` 两套全新 Snapshot/ref，并都按语义重新发现 `role=upload, name=上传`。
- 针对 React/SPA 首次 Snapshot 偶发空树，增加最多三次、间隔 400ms 的空结果稳定重试；只在控件树暂时为空时重试，不循环执行页面动作。
- 未选择、上传任何真实或测试音频，未点击发表。

## 其他平台入口收紧

- 视频号：只允许 `channels.weixin.qq.com/platform/post/create`，明确拒绝 `/platform/post/list`；真实打开后进入官方登录页并正确 handoff，当前等待用户扫码。
- 视频号入口存在前端延迟重定向；导航器现会等待最终 URL 静默 2.5 秒，并只把 Chromium 的预期 `ERR_ABORTED` 当作重定向过程，其他加载错误仍失败。真页复验已直接返回最终 `/login.html` 与 handoff，不再短暂误报投稿页可用。
- 抖音：从旧的整站权限收窄到 `/creator-micro/content/upload`、`/creator-micro/content/post/video` 和 `/creator-micro/content/post/image`。
- 小红书：收窄到官方 `/publish` 投稿面；`/new/home` 不放行。
- 快手：收窄到官方高清视频上传页 `/article/manage/video`；父级内容管理页不放行。
- 微信公众号：同一个 `/cgi-bin/appmsg` 同时承载编辑和列表，现已增加 query 级规则；只允许 `action=edit` 且 `t=media/appmsg_edit(_v2)`，`action=list_ex` 与后台根页均拒绝。
- 迁移脚本会替换同一官方 origin 的旧根路径，而不是在旧权限旁边追加新路径，避免“看似收紧、实际仍整站放行”。

## 视频号兼容与隐私修复

- 视频号二维码能显示但扫码后反复退回登录页，根因是 Electron 默认 UA 暴露运行时品牌；现已在 app、session 和内容 WebContents 三层统一为对应内核版本的标准 Chromium UA，且单测禁止 `Electron/` 品牌回归。
- UA 修复加载后，真实页面成功停在 `channels.weixin.qq.com/platform/post/create`，不再退回登录页。
- 首次视频号 Snapshot 暴露了侧栏、账号区、位置和页脚静态文字。自动化已立即 handoff 冻结；代码现采用贡献型 hint 白名单，并过滤首页、内容/互动/视频/数据管理、收入、设置、通知、草稿箱、账号名和页脚等非表单信息。
- “声明原创”复选框归入法律/权利声明人工门；“发表”和按钮式“上传”归入最终动作人工门。专用 `browser.upload` 的语义文件绑定仍可用。
- 为避免再次要求用户登录，修复只做了离线金样，没有重启当前已冻结实例；下次用户明确允许启动时自然加载。

## 回归结果

- `npm run check`：通过，39 个 JavaScript 源码/脚本文件语法有效。
- `npm test`：34 项通过，隔离协议项默认跳过并由下一条单独执行。
- `npm run test:upload`：通过原生输入与语义入口两条 Electron/CDP 路径。
- `npm run test:protocols`：在随机 loopback 端口以隔离 daemon 同时通过 HTTP、WebSocket 与真实 MCP stdio 链；九个 MCP 工具中无发布、删除、脚本或选择器接口，不触碰账号浏览器。
- `npm run test:python`：3/3 通过，覆盖 Nova 固定 token、loopback 门和 workspace 上传边界。
- NovaGe/NovaDe 正式 `agent.py` 文件语法与工具登记通过。
- 审计回归确认：填写正文不会持久化；只保存长度和 SHA-256。一次测试中发现的 content-derived AX name 泄漏已修复，对应测试日志行已删除。

## 尚未完成

1. 小宇宙 P0 真任务：需要正式音频、标题、Show Notes 与可选封面；浏览器可填表和上传，但必须停在协议与“创建”前交给用户。
2. 喜马拉雅：等待用户提供正式音频后继续进入上传后的标题、专辑、简介/文案表单验收，并停在最终发表前。
3. 公众号、小红书、抖音、快手分别做一次真实发布面验收。视频号已确认 UA 修复后可进入发表页；隐私过滤补丁已离线通过，待用户未来明确允许时再做一次不登录、不上传的最终验收。
4. Suno/MIDI 当前冻结。适配定义仍保留，但已从默认启用集合和本机 allowlist 移除；实测 `/create` 在 daemon 发出浏览器请求前返回 `outside_contribution_scope`。用户重新明确授权前不执行任何页面或下载动作。
5. P1 才考虑特权确认 UI、应用打包签名、自动启动、平台策略管理界面等体验项。
6. 项目与三份报告已有独立 Git 基线提交 `d9f120b`；后续只提交浏览器项目及对应决策/报告，不纳入工作区其他文件。

## 启动与接入

```bash
cd "/Users/evanguo/Documents/New project2/agent-chrome-lite"
npm start
```

Codex/Claude 配置说明：`agent-chrome-lite/config/MCP-SETUP.md`。Codex 与 Claude 新配置在各自客户端重启后生效。

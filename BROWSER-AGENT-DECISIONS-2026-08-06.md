# 本地 Agent 浏览器：决策记录

日期：2026-08-06；2026-08-07 更新  
状态：G0 已通过，P0 通用内核已实现并完成首轮回归；小宇宙真单集上传仍等待用户提供正式素材。喜马拉雅已接入权限注册并通过官方入口到扫码登录的 handoff 门。Suno 线按用户最新指令冻结。

## 目标

构建一个 Agent 无关的本地浏览器控制层，供 Codex、Claude、NovaGe、NovaDe 及后续自定义 Agent 使用。浏览器用于把用户自己的作品送上平台；不用于采集平台数据。Suno/MIDI 保留在设计范围，但当前不得操作。

小宇宙与 Suno/MIDI 是 G0 的代表性验证样本，不是产品支持平台的上限：

- 小宇宙验证复杂发布表单、富文本、文件上传和最终人工发布门。
- Suno/MIDI 验证逐条生成、任务账本、credits 门、结果对账、Studio/canvas 和自有资产下载。
- 正式范围还包括喜马拉雅、公众号、小红书、抖音、快手、视频号，以及后续所有没有可靠创作者 API、只能通过网页完成内容生产或上架的平台。
- Podbean 等已有可靠创作者 API 的平台优先走 API，不强行走浏览器。

## 已确认的架构决策

1. HTTP/WS 是控制本体；P0 只增加 MCP 薄适配器。
2. Codex 与 Claude 走 MCP；NovaGe 与 NovaDe 直接调用 HTTP。
3. 通用 CLI、TypeScript SDK、Python SDK 不进入 P0。
4. `agentId`、`capabilities`、`confirmationPolicy` 均由 daemon 根据本地凭证和配置派生，Agent 无权自报或提高权限。
5. 不可逆动作由 daemon 在动作发出前，根据节点角色、名称、表单属性、URL 和页面上下文识别并拦截。
6. P0 不做特权确认窗口，只做阻断和 handoff；协议确认、最终创建、发布等动作由用户本人完成。特权确认 UI 属于 P1。
7. Agent 控制协议不提供遍历列表、批量抓取、HTML/DOM 导出、网络拦截、爬站或任意 JavaScript 等采集能力。
8. Snapshot 只返回完成当前内容生产或上架任务所需的表单、控件、提示和状态。
9. 受限动作执行器必须按人的操作速度节流；单账号、低频、串行，不跑机器极限速度。
10. 禁止把 CSS、XPath 或固定坐标作为定位策略；允许 CDP `setFileInputFiles` 等作为已经通过语义/ref 找到目标后的机制调用。
11. 每个平台的差异放在服务端平台策略和风险词配置中，不把平台选择器或流程写进浏览器内核。

## weband 宪法

- 只添加用户自己的数据，不采集平台或他人数据。
- 登录、密码、验证码永远由用户本人处理。
- 失败即停，不试探绕过。
- 不碰用户日常 Chrome，只使用独立 Profile。
- 发布、删除、支付、授权等不可逆动作必须由用户本人完成，或在未来 P1 中取得针对单次具体动作的明确授权。

## Suno/MIDI

**当前冻结：用户明确要求“suno你别动”。在用户重新明确授权前，不打开、不点击、不填写、不生成、不下载，也不碰 MIDI、credits 或相关页面。以下条目只保留为未来恢复时的治理决策，不代表当前执行权限。**

冻结已落实到代码与本机配置：Suno 保留在平台 registry 供未来恢复，但不属于默认启用平台，并已从 `~/.agent-browser-local/config.json` 的 contribution allowlist 移除；真实 daemon 导航测试在浏览器发请求前拒绝 `/create`。

- 新浏览器必须接管 Suno 的页面操作；`suno-manual-generation` 继续作为独立专岗和治理层。
- 每次作业必须有 `job.json`，一次只提交一个 prompt，同时最多一个 `submitted` segment。
- Suno Create 只有在账本、页面状态和预授权 credits 预算全部通过时才能逐条触发；严禁循环批量点击。
- clip 必须按提交前后 manifest 和新 clip ID 对账。
- 自有音频、stems 和 MIDI 可以下载，但必须绑定当前任务并做大小、格式和 SHA-256 验收。
- Get MIDI 必须记录源 clip、stem、预期 credits、状态、文件路径和哈希。
- Suno Publish 仍由用户本人完成。

## G0 通过标准

### 小宇宙

1. Snapshot 能按语义发现标题、Show Notes、音频上传、封面、协议和创建按钮。
2. 刷新页面或重新进入后台后，重新 Snapshot 仍能找回同一批字段，不使用旧 ref。
3. Show Notes 使用多段落、换行并至少包含一个链接；填写后读回结构和内容一致。
4. 文件上传目标必须先由语义/ref 定位；之后允许使用 CDP 文件绑定机制。
5. 不勾协议、不点击创建。

### Suno/MIDI

1. Create 页能发现 Title、Prompt/Lyrics、Style、模式和 Create。
2. 结果页能发现生成状态和当前作业的 clip 身份。
3. Studio 能发现 stems、Get MIDI、credits 提示和 MIDI 下载入口。
4. 普通控件优先 Snapshot/ref；只有 canvas 等确实缺少无障碍节点的区域允许使用当前截图动态定位，禁止固定坐标。
5. G0 不提交生成、不消耗 credits、不下载或发布，仅验证可发现性和交互机制。

## Go / No-Go

- G0 已通过，P0 通用内核已进入工程实现并通过首轮测试。
- 关键表单、Show Notes 或上传控件只能依靠写死选择器或固定坐标时，停止实施并报告 No-Go。
- Suno Studio 的 canvas 局部允许使用实时视觉定位；仍无法可靠确认时 handoff，不自动试探。

## 当前实现状态

- 独立 Electron/Chromium 窗口、独立 Profile、本地 daemon、HTTP/WS、Snapshot/ref、动态截图点击、CDP 文件绑定、人类节奏和审计已实现。
- daemon 本地身份表已配置 Codex、Claude、NovaGe、NovaDe；权限与确认策略不可由 Agent 自报。
- Codex 与 Claude 的固定 principal MCP 已登记；NovaGe 与 NovaDe 的正式 `agent.py` 已接入固定 principal HTTP 工具。
- 小宇宙真页面已验证刷新后重新发现、Show Notes 多段落/空行/链接精确读回，以及音频/封面语义上传入口。
- 未在小宇宙上传测试文件，未勾协议，未点击创建；P0 真任务等待正式音频、标题、Show Notes 与可选封面。
- 喜马拉雅已核实官方入口 `studio.ximalaya.com/upload`，加入本机权限表，并真实验证跳到 `passport.ximalaya.com` 后 daemon 自动 handoff、冻结 Agent。用户扫码登录后，上传入口语义发现与重新进入后的新 ref 再发现均通过；等待正式音频后再验上传后的信息表单。
- 视频号已核实官方创作域名 `channels.weixin.qq.com`；协议层只登记精确投稿路径 `/platform/post/create`，不放行作品列表 `/platform/post/list`。登录后的发布面仍需验收。
- 视频号要求标准 Chromium UA；Electron 运行时品牌会导致扫码后继续退回登录。UA 兼容修复已真实进入发表页。此后发现的静态 hint 泄漏已改为贡献型白名单并离线冻结金样，当前实例保持 handoff，不为加载补丁再次要求用户登录。
- NovaGe/NovaDe 的正式 `agent.py` 只保留薄工具定义；共用 Python HTTP 客户端放在浏览器项目 `adapters/python/`，固定 principal、loopback 和 workspace 上传边界均由代码执行。
- 抖音、小红书、快手已将旧的 origin 根路径收窄为各自官方投稿路径；本机迁移会删除同 origin 的旧根路径后写入精确路径，不能只追加造成假收紧。
- 微信公众号的图文编辑器与历史列表同属 `/cgi-bin/appmsg`，因此权限不能只看 path；daemon 还要求 `action=edit` 和 `t=media/appmsg_edit(_v2)`，明确拒绝 `action=list_ex`。
- 公众号、小红书、抖音、快手仍需分别完成一次发布面验收；它们共享通用内核，但不得因小宇宙通过而宣称已验证。

## 公众号发布 API 调研结论

已于 2026-08-06 核对微信官方文档：`/cgi-bin/freepublish/submit` 的“发布草稿”能力，公众号仅限企业主体已认证账号，服务号可调用；官方同时说明自 2025 年 7 月起，个人主体、企业未认证及不支持认证的账号会被回收发布能力接口权限。因此，只有账号条件与后台权限实测满足时才优先走 API；否则继续使用本独立浏览器，并保持最终发表由用户本人点击。

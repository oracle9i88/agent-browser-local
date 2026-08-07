# 本地 Agent 浏览器：G0 可行性验证报告

日期：2026-08-06  
范围：仅验证机制，不启动独立浏览器的全面开发。  
结论：**核心路线通过；后续独立 Electron/CDP 工程已补齐并通过文件上传闭环。**

## 总结

- 小宇宙的创建单集表单可由 Snapshot/无障碍语义识别，Show Notes 富文本和刷新后重新发现均通过。
- Suno Create、歌曲身份、Studio、分轨、Get Stems / MIDI、下载格式、发布入口和 credits 余额均可发现；刷新后使用新 ref 能再次找到 MIDI 入口。
- 没有点击小宇宙协议或创建，没有向 Suno 提交生成，没有触发分轨/MIDI、下载、发布或 credits 消耗。
- 小宇宙上传弹窗最终暴露了原生 `input[type=file]`，因此定位机制成立；但现有 Chrome 测量外壳未能完成 file chooser 绑定验证。P0 第一项工程验收必须用独立 Chromium/CDP 的 `DOM.setFileInputFiles` 对一个测试文件跑通，之后才允许进入小宇宙真上传验收。

## G0-A：小宇宙

### 已通过

1. 创建单集抽屉能发现：
   - 标题输入框：`name=title`、占位文字“输入单集标题”。
   - Show Notes：`contenteditable=true`、`role=textbox`。
   - 协议复选框和协议链接。
   - 提交按钮“创建”。
   - 音频上传、单集封面、点击上传封面和素材库等上下文文字。
2. Show Notes 保真测试通过：
   - 两个正文段落。
   - 中间空行和换行。
   - `https://example.com/g0-snapshot` 链接。
   - 填写后 Snapshot 读回时仍为独立段落，链接被识别为链接节点。
3. 页面刷新后重新 Snapshot：
   - 旧 ref 失效并被替换为新 ref。
   - 标题、Show Notes、协议和创建按钮仍能按语义重新找到。
   - 测试草稿被清空，没有遗留提交内容。
4. 上传弹窗打开后可发现：
   - “选择文件 或拖拽”提示。
   - WAV、MP3、M4A 等格式提示。
   - 原生 `input type=file` 节点。

### 条件项

- 页面顶层“创建”加号和部分上传按钮没有可用的无障碍名称，需要“当前截图动态定位 + 动作后重新 Snapshot”，不能仅靠纯语义 ref。
- 这不是固定坐标方案；坐标不得跨页面、跨会话记忆。独立浏览器应在每次动作前基于当前截图重新定位，并在动作后以 Snapshot 校验页面状态。
- 现有 Chrome 测量外壳对 file chooser 的两次机制调用超时，因此没有绑定或上传测试文件。P0 必须用 CDP 节点映射后的 `DOM.setFileInputFiles` 完成闭环；禁止退回 CSS/XPath。

### 未执行

- 未选择或上传音频、封面。
- 未勾选协议。
- 未点击“创建”。

## G0-B：Suno / MIDI

### Create 与作业身份

Snapshot 可发现：

- Simple、Advanced、Sounds 模式。
- v5.5 模型入口。
- Audio、Voice、Inspo。
- Lyrics editor：`contenteditable`、`role=textbox`、`aria-label=Lyrics editor`。
- Styles 文本框、歌曲标题和 `aria-label=Create song` 的 Create 按钮。
- 当前工作区、搜索、筛选、排序和分页。
- 每首歌曲的标题、播放节点和稳定歌曲 URL，例如 `/song/<clip-id>`。

这足以支持 `job.json` 与新 clip ID 对账，但不授权批量遍历歌曲列表；只能围绕当前任务核对提交前后新增 clip。

### Studio、Stems 与 MIDI

进入一个已有工程后，Snapshot 可发现：

- 工程名 `The Most Beautiful Cello & Piano Adagios_5min`。
- Keyboard、Strings、Synth、FX 等 5 条现有分轨。
- Add Track、Upload、Export、BPM、拍号、时间位置和剩余 credits。
- Export 菜单中的 Full Song、Selected Time Range、Multitrack。
- 歌曲菜单中的 Publish、Download、Manage、Move to Trash。
- Edit 子菜单中的 `Get Stems / MIDI`、`Open in Studio`、`Open in Editor`。
- Download 子菜单中的 MP3 Audio、WAV Audio、`Get Stems / MIDI`、Video。

Studio 分轨“三点”按钮缺少无障碍名称，采用当前截图动态定位打开；打开后菜单文字可由 Snapshot 读取。该视觉降级只允许用于当前画面中的无名/canvas 控件，不得保存为固定坐标。

### 刷新后重新发现

- 刷新 Create 页面后，歌曲、Create 表单和 More options 全部获得了不同 ref。
- 使用新 ref 重新找到同一首歌曲，再由当前菜单的 Edit 语义重新发现 `Get Stems / MIDI`。
- 下载子菜单也重新出现 MP3、WAV、MIDI 和 Video。
- 余额刷新前后均显示 `Credits remaining: 9,990`，说明本次验证没有扣费。

### 未执行

- 未填写或提交任何 prompt。
- 未点击 Create。
- 未点击 Get Stems / MIDI。
- 未下载文件。
- 未点击 Publish、Move to Trash 或其他不可逆/高风险动作。

## Go / No-Go 判定

### 可以继续的范围

允许进入 P0 的第一小段：独立 Chromium 壳、独立 Profile、本地 daemon、Snapshot/ref、当前截图动态视觉降级、动作节流、审计日志和权限闸门的最小骨架。

### 尚未授权或尚不能宣称的范围

- 不能宣称“独立浏览器已完成”。
- 不能开始小宇宙真上传、真创建或 Suno 真生成。
- 不能因为两个代表样本通过，就宣称喜马拉雅、公众号、抖音等所有平台已验证；它们仍需各自的发布面验收，但共享同一浏览器内核。
- 在独立浏览器里跑通 CDP 文件绑定前，不进入小宇宙上传适配器的正式实现。

## P0 第一段建议顺序

1. Electron/Chromium 独立浏览器与独立 Profile，不读取用户日常 Chrome 数据。
2. daemon 本地身份映射：凭证 → `principal` → capabilities/confirmation policy；拒绝 Agent 自报权限。
3. contribution-only 协议：Snapshot、click/ref、fill/ref、upload/ref、受限导航；无采集、列表遍历、任意 JS 或网络拦截能力。
4. 动作前风险分类与强制阻断：创建、发布、删除、支付、授权、Suno Create、Get Stems/MIDI credits。
5. 人类节奏执行器：串行、节流、失败即停、最多一次有新证据的重试。
6. 先跑 CDP `DOM.setFileInputFiles` 工程金样；通过后再接小宇宙，随后接 Suno 专岗账本。

## 2026-08-06 P0 补充验证

- 独立浏览器已在小宇宙真页面重新验证刷新/重进后的字段可发现性。
- Show Notes 多段落、空行和链接最终实现逐字符一致读回。
- 真页面 Snapshot 已出现音频与封面语义 upload ref；未向真实账号上传测试文件。
- 离线 Electron 金样已同时通过原生 file input 和“语义入口 → 拦截 file chooser → 核验原生 input → CDP 绑定”两条路径。
- Snapshot 已收紧：非贡献表单页不返回静态评论/统计，分析、评论和记录型链接被过滤。
- Suno/MIDI 后续执行按用户最新指令冻结；本报告中此前的只读发现结果仅作为历史证据。

## 最终判定

**G0 核心假设成立：Snapshot-first + 当前视觉动态降级 + CDP 机制调用可以作为独立 Agent 浏览器的地基。**  
**文件上传工程闭环已通过；下一道门是拿正式素材完成一次小宇宙真上传，并停在协议与“创建”前。**

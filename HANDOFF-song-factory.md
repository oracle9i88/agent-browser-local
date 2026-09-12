# 交接说明：song-factory 产线集成与待解问题

> 本分支（`feature/auth-check-status-targets`，10 个提交，main 未动）由 song-factory 产线（`~/song-factory`，Node CLI）的维护方提交。
> Codex：请通读本文件 + `git log main..HEAD`，产线侧调用代码在 song-factory 仓库，两边对照看。

## 一、本分支已交付并实测通过的能力

| 能力 | 端点/机制 | 验证 |
|---|---|---|
| 登录态探活 | `POST /v1/auth/check {platform}`（finalize 级，只回 boolean，审计留痕） | douyin/kuaishou/wechat_channels ✓ |
| 作品状态只读路径 | `STATUS_TARGETS` 注册表 + 新能力 `browser.verify.ref`（`--grant-verify`） | 视频号 /platform/post/list 放行/拦截均 ✓ |
| 冻结自愈 | `POST /v1/handoff/clear`（finalize 级） | ✓（无人值守恢复原则：绝不叫人工点） |
| 媒体文件导航转下载 | `isMediaFileUrl` → will-navigate 拦截 + downloadURL | 代码路径就绪（见问题 1，站点不导航所以未触发） |
| MiniMax 网页工作室白名单 | minimax.cn/audio | 生成链路全通 |
| GenSpark 白名单 | genspark.ai | 导航 ✓（登录见问题 2） |
| GenSpark Cookie 同步 | 迁移向导新 offer（实测 `c2` 为会话 Cookie） | 同步完成但登录未生效（见问题 2） |

## 二、需要 Codex 解决的问题（按优先级）

### 问题 1（阻塞产线音乐工位）：MiniMax 网页端"作品"下载无法自动化

**现象**：作品列表卡片对 a11y 快照完全不可见（同快手二阶段表单）。卡片 ↓ 图标点开是格式菜单（`MP3(无水印)` ✓订阅默认 / `MP3(有水印)`）。用 daemon 的 visual-click 点菜单项（坐标经证据截图逐次校准确认无误中）后：**无 will-download、无页面导航、无文件落盘**。

**已排除**：
- 坐标系问题（daemon 截图 width 即 CSS 视口宽，坐标已换算）
- 站点导航式下载（已加媒体导航转下载拦截，未触发）
- 选中项点击是 no-op 的假设（改选另一项再点 ↓ 也无效）

**未试线索**：
- 卡片 **⋮ 菜单**里可能有真正的下载动作（比 ↓ 的格式菜单更直接）
- 抓包复刻：浏览器开发者工具看点击下载时的真实网络请求（很可能是带鉴权的 fetch → blob → saveAs，若如此 Electron 行为取决于 session 配置，且 `saveAs` 会弹系统对话框——你们的 will-download handler 已 setSavePath，但 blob+showSaveAsButton 路径未必覆盖）
- 菜单项的 React 事件是否依赖特定 pointer 事件序列（daemon 的 press/release 间隔 90ms 一般没问题）

**证据**：`~/song-factory/jobs/01M2AMDY…/music/calibration-web/download-*.png`（每次点击的目标/菜单截图）。
**产线侧入口**：`~/song-factory/src/services/music/minimaxWeb.ts` 的 `downloadWork()`。修好交互后产线零改动接上。
**当前资产**：用户 MiniMax 账户作品区已有 4 首成品（《世界孤寒》×2《跟我隻槳》×2），下载一通即可入库。

### 问题 2（图像工位绕行中）：GenSpark 会话不可 Cookie 移植

GenSpark 是 Google OAuth 账户（`oracle9i88@gmail.com`，订阅含无限生图+商业使用权至 2026-12-31），OAuth 登录在 Electron 内被 Google 拒（"浏览器不安全"）。本会话桥+迁移向导路径已走通（Cookie 同步成功，实测会话 Cookie 为 httpOnly `c2`），**但注入后页面仍显示未登录**——判断其前端令牌在 localStorage，而迁移器按安全契约不迁 localStorage。
当前产线走**用户明确授权的绕行**：直接 CDP 驱动登录态桥 Chrome（9222 端口）操作 GenSpark `/ai_image` 智能体，已全自动跑通（生图+参考图角色一致+下载）。若想把 GenSpark 收进 agent 浏览器正式能力，需要 localStorage 迁移方案（涉及凭据边界，需老板安全决策）。

### 问题 3（P2，发布全自动化的前置）：快照不暴露二阶段表单控件

四个平台实测：上传/标题/发布按钮在快照里可见可控，但**自定义表单控件**（抖音"自主声明/作品简介/话题"、快手全部字段——假 placeholder 的 div 层叠实现）不进 a11y 快照。产线现用 humanFinalGate 兜底（自动传+填，人工 30 秒收尾声明+点发布）。
若快照能以 opt-in 能力（如 `browser.form.read`）暴露 input/textarea/combobox 的 placeholder/name，发布工位可逐个翻全自动。风险与隐私姿态由你们定。

## 三、协作约定

1. **永不碰 main**；所有改动在本分支小步提交。
2. 冻结/故障恢复是程序职责：`handoff → POST /v1/handoff/clear` 或重启应用，**绝不要求人工点"交还 Agent"**。
3. 产线的平台配方（控件正则、坐标、踩雷清单）在 song-factory 侧，浏览器只提供原子能力。
4. 本分支未 push（老板本机无 gh 凭据）；Codex 本地读取或老板 `gh auth login` 后推。

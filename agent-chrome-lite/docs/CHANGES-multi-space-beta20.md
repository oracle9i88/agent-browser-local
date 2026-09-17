# beta.20：多工作空间

日期：2026-09-17。基线：8b867c5（beta.19 分支）。

## 范围与会话兼容性

一个应用、一个 daemon、三个可切换的独立页面。默认 Space 的 ID、partition、runtime/userData 路径和应用 bundle ID 均不变；不自动搬移 Cookie，不关闭现有应用，不碰真实账号。新增 publishing 和 music 两个持久化 Space，初始为 about:blank。

每个页面使用自己的 BrowserController、CDP、popup router、network egress policy 和 session。后台页面的状态或网络错误不会改变前台的 handoff。弹窗继承所属 partition 和归属。已有下载继续由原控制器管理，审计记录包含来源 Space。

## 执行边界

WorkspaceRouter 给现有 daemon 提供稳定 controller facade。一次 dispatch 从检查到执行、审计完成，全程持有互斥锁；等待人类节流期间也不能切换。竞争请求返回 workspace_busy。UI 导航、认证同步和迁移同样受保护；用户主动接管仍可随时触发。切换清除目标页面旧 ref，不会清理 Cookie。

可选请求 spaceId 只做前台目标校验，不授予 Agent 切换权。没有改变 capabilities/confirmationPolicy/域名 allowlist 或既有代发布授权。

迁移回滚仅选择当前 Space 的记录；跨 Space 指定 migrationId 拒绝。启动恢复按 manifest.space.id 查 session，旧无 Space 记录回到 default。rollbackFailed 的已提交记录也会继续恢复。

## 验收

- npm run check：79 文件通过。
- npm test：173 项，172 pass / 0 fail / 1 skipped（协议测试按原配置跳过）。
- npm run package:mac：beta.20 app 和 zip 构建通过。
- npm run test:packaged：临时 runtime + 临时 profile；三个空间 Cookie 实测隔离、切换后原 Space Cookie 保留、前后台可见性、工具栏空间按钮、迁移面板及接管按钮、daemon 与单实例检查通过。
- npm run test:protocols：HTTP、WebSocket、MCP 隔离 daemon 回归通过（单独开启原先默认跳过的协议测试）。
- 新回归：稳定 facade、旧 ref 失效、执行中禁止切换、竞争 Agent 拒绝、故障释放锁、后台状态隔离、下载来源、跨 Space 恢复、回滚记录隔离。

没有进行任何真实平台登录/发布/下载。这些必须在用户正常使用时另行验收，不宣称与平台登录兼容性有关的问题已解决。

## 未包含

多窗口、多 Agent 同时独立操控、任意创建账号空间、最后页面 URL 的跨重启恢复、自动拆分旧登录态。新空间需要独立登录，不强制用户立即搬迁。真实账号原样留在 default。

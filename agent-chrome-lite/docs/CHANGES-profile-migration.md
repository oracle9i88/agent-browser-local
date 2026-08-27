# CHANGES：登录态迁移向导（Chrome → Agent）— 交付审计文档 v2

> 实现方：GLM。分支 `glm/profile-migration`，基线 `4cedd9e`。
> v2：针对 Codex 审计退回的 5 项阻塞项逐一修复，本文档重写为修复后状态。
> 状态：**待 Codex 复审**。不自行合并、不推送、不宣布完成。

## 0. 架构决策（方案 A，审计口径按修正后的表述）

> CDP 会话桥按 **URL 范围**读取（`Network.getCookies{urls}`）。Chrome 会返回这些
> URL 下的**全部** Cookie，因此**白名单外名称的 Cookie 仍会短暂进入主进程内存**，
> 收到后同步按平台名字白名单过滤、其余立即丢弃。用户逐域授权的 Cookie 明文只在
> **Electron 主进程内存**中短暂处理，注入目标 Space 的 cookie store 后立即丢弃——
> 不持久化、不展示、不记录、不导出、不进 Renderer / daemon API / 审计日志 /
> 文件 / Agent Snapshot。
>
> （v1 文档声称"非授权 Cookie 不会进入内存"，系过度承诺，已按审计意见纠正。）

辅助决策：非凭据文件级拷贝（bookmarks、localStorage）仍未实现，理由同 v1。

## 1. 审计阻塞项修复对照

| # | 审计意见 | 修复 | 证据 |
| --- | --- | --- | --- |
| 1 | 向导未调用 `migrationOffers()`，域名永远为空 | `buildPanel` 改 async，面板构建时 `await bridge.migrationOffers()`，成功后渲染逐域勾选；失败显示错误并可继续使用回滚 | `migration-wizard.js renderOfferList()`；启动冒烟（面板可打开，域名为平台真实数据） |
| 2 | manifest 写入失败不回滚 | `manifestStore.save()` 失败 → 回滚本次全部已注入 Cookie → 抛 `migration_manifest_save_failed`（无回滚记录的状态不允许存在） | `profile-migrator.mjs runLoginMigration`；测试 `"manifest save failure rolls back injected cookies (constraint 8)"` |
| 3 | Space 隔离未交付 | 新增 `src/browser/space-manager.mjs` + `src/browser/tab-ownership.mjs`；**Agent 浏览会话整体迁入默认 Space 持久化 partition**（`persist:abl-space-default`），egress 策略、Suno 同步、迁移注入全部跟随 browsing session；迁移 manifest 记录目标 Space | 测试 `test/space/space-isolation.test.mjs`（5 项：partition 唯一性、跨 Space 不可见契约、registry 持久化、非法 id 拒绝、tab 归属 fail-closed）；冒烟确认 `Partitions/abl-space-default` 生成 |
| 4 | Cookie 安全文案过度承诺 | CHANGES §0、模块 docblock、`collectPlatformCookies` 注释、向导提示与 confirm 文案全部改为如实表述（URL 范围读取 → 名字过滤 → 非白名单短暂入内存即弃） | 见 §0 与代码注释 |
| 5 | 回滚字段不一致（`removed` vs `removedCount`） | 后端统一返回 `removedCount`（与 manifest 字段同名）；向导读取不变 | 测试 `"manifest records the target space and rollback reports removedCount"` |

另：`docs/glm-task-profile-migration.md`（任务书 v2）已入库；公开推送前是否保留由审计人定夺。

## 2. Space 隔离交付说明（对应审计项 3）

- **space-manager**：Space 注册表（`<runtime>/spaces/registry.json`，0600，原子写），
  每个 Space 固定 partition `abl-space-<id>`，解析为 `session.fromPartition("persist:abl-space-<id>")`。
  跨 Space Cookie 不可见由 Electron partition 机制结构性保证；测试以注入 sessionFactory
  的方式固化该契约（不同 Space 永不共享 session 实例）。
- **tab-ownership**：tabId → spaceId 归属表；未绑定 tab 一律 fail-closed 归属默认 Space；
  换绑必须显式 `rebind`。当前 `createWindow` 将 contentView 绑定默认 Space。
- **main.mjs 变更（此为架构变更，请重点审）**：
  - contentView `webPreferences.partition = persist:abl-space-default`；
  - 浏览会话 UA、egress 安装、Suno external-auth 同步目标全部从 `defaultSession`
    换成 browsing session；
  - **兼容性提示**：旧版写入 `defaultSession` 的 Suno 会话 Cookie 不再被浏览会话
    看到，升级后需重新点一次"同步认证"（beta 阶段可接受；如需自动搬迁请审计人裁决）。
- **已知边界**：多 Space 并存浏览（按 Space 创建多个 WebContentsView + 每 session
  egress）未在本次实现，属于独立 UI 工程；当前为单一默认 Space 浏览 + 迁移按 Space
  记账。是否纳入本分支由审计人裁决。

## 3. 十条硬约束 → 实现位置对照

同 v1，第 4/5/8 条表述与实现按 §1 修复后口径：

- #4 平台名字白名单：CDP 返回 → **同步**名字过滤 → 非白名单即弃（不做二次处理）；
- #5 值只在主进程：摘要/manifest/错误仅含计数、域名、Cookie 名（`SECRET-…` 注入测试断言序列化不含值）；
- #8 回滚：前置失败不注入；注入后先登记回滚清单再验证；验证失败自动回滚；**manifest 写失败自动回滚**；显式回滚只动 manifest 列表。

## 4. 实现方自测（修复后）

- `npm run check`：64 文件语法通过；
- `npm test`：**94 tests，93 pass / 0 fail / 1 skipped**（新增 space 5 项、migrator 2 项）；
- 无头启动冒烟（临时 runtime、独立端口）：daemon 监听、UI 初始化、
  `spaces/registry.json` 与 `profile/Partitions/abl-space-default` 生成、自动退出正常。

## 5. 留给审计人的验收项（未变 + 新增）

1. `npm run package:mac` + `npm run test:packaged`（上次已过，本次改动后需重跑）；
2. 六平台真实登录迁移 + cookieNames 校准（Suno/公众号/抖音/小红书/快手/网易云）；
3. 回滚演练：同步 → 回滚 → 目标 Space 未登录态、其他数据无损；
4. 越权面复核：`git diff main..HEAD -- src/security src/server src/constants.mjs src/browser/auth-bridge.mjs src/browser/external-auth.mjs src/browser/chrome-launcher.mjs src/browser/cdp-session.mjs` 应为空；
5. 明文泄漏面复核（IPC 返回值 / manifest / 审计日志）；
6. **新增**：defaultSession → partition 迁移的架构变更评审（§2），及旧 Suno 会话是否需要自动搬迁；
7. **新增**：多 Space 并存浏览是否纳入本分支或后续工程（§2 已知边界）。

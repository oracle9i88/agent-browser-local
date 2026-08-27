# CHANGES：登录态迁移向导（Chrome → Agent）— 交付审计文档 v4

> 实现方：GLM。分支 `glm/profile-migration`，基线 `4cedd9e`。
> v4：修复第三轮审计的 Cookie 覆盖冲突 P0（冲突即中止，不覆盖、不存旧值明文）。
> 状态：**待 Codex 复审**。不自行合并、不推送、不宣布完成。

## R3. 第三轮审计修复（P0：已有 Cookie 被覆盖后无法无损回滚）

| 要求 | 实现 | 证据 |
| --- | --- | --- |
| 1. 注入前检测目标 Space 同名 Cookie | 新增 `findConflictingCookies()`：逐条 `cookieStore.get({name})` 后按域名重叠（双向后缀匹配）判定冲突；在 WAL 写入**之前**执行 | `profile-migrator.mjs` 步骤 1.5 |
| 2. 冲突默认中止，不覆盖 | 任一冲突 → 抛 `migration_cookie_conflict`，整个迁移零注入（发生在任何 set() 和 WAL 记录之前）；冲突清单仅含 Cookie 名+域名，**不含任何值**，旧值明文不落 manifest | 测试 `"existing cookie conflicts abort the migration without overwriting"`：预置 OLD 值 → 迁移被拒 → OLD 原样保留、无其他注入、manifest 零记录 |
| 3. UI 提示 | 错误消息直含指引：“Agent 中已有同名登录态（…），为避免覆盖丢失，本次未同步。请先回滚上次迁移或清理后再同步”；向导状态区原样展示 | 同上测试断言 |
| 4. 回归测试 | 同上 + 跨域同名不误伤（`.other.example` 的 `__client` 不阻塞 suno.com 迁移） | 两条新测试 |
| 5. 启动恢复只清理真正新增的 Cookie | 冲突守卫保证：凡进入 manifest/WAL 的 Cookie 必然是全新（无冲突）的，回滚/恢复的 remove 永远不会碰预存登录态；恢复测试新增无关预置 Cookie（`MUSIC_U`）断言其存活 | `"pending manifest entries are recovered on startup"` 更新 |

安全边界确认：未采纳“旧 Cookie 明文写入 manifest”方案，与审计意见一致。

## R2. 第二轮审计修复（P0）

| # | 审计意见 | 修复 | 证据 |
| --- | --- | --- | --- |
| 1 | 单平台注入中途失败，前半批 Cookie 不回滚（实测残留 1、回滚 0） | 注入改为逐条 `set()` 后**立即登记回滚账本**；任意一条失败即回滚全部已登记项。删除了旧的整体完成后才登记的逻辑 | 测试 `"mid-injection failure rolls back earlier cookies of the same platform"`（第 2 条 set 抛错 → 第 1 条被回滚，jar 为空，manifest 状态 `rolled_back`） |
| 2a | 回滚失败被 `.catch(() => undefined)` 静默吞掉，仍报"已回滚" | `rollbackInjectedCookies` 改为逐条 try/catch 汇总 `{succeeded, failed}`；任一失败 → 抛 `migration_rollback_failed`，**绝不报"已回滚"**；manifest 记 `rollbackFailed: true` 留待清理 | 测试 `"rollback failure is escalated, not swallowed"`（remove 全部失败 → 报错码 `migration_rollback_failed`、jar 保留 2 条、manifest `rollbackFailed` + `pending`） |
| 2b | 建议增加启动续清理 | 新增 `recoverPendingMigrations()`：启动时扫描 `pending`/rollbackFailed 记录，按 manifest 清单幂等移除残留 Cookie，成功后标记 `rolled_back` + `recoveredAt`；main.mjs 启动时调用，输出仅含计数的 console.warn | 测试 `"pending manifest entries are recovered on startup"`；main.mjs 启动序列 |
| 附加 | 崩溃窗口：注入后、manifest 写入前崩溃会留下无记录 Cookie | manifest 改为 **write-ahead**：注入前先写 `pending` 条目（仅名/域/路径，无值）→ 注入+验证 → `committed`；任何时点崩溃，磁盘上都有一份可恢复清单。回滚/提交的中间状态写失败时，pending 记录仍在磁盘，启动恢复范盖 | 流程见 `runLoginMigration`；新增测试 `"committed manifest save failure rolls everything back"`、`"pending manifest write failure means nothing was injected"` |

附带加固：非 sanitized 的底层 store 异常不再原样抛向渲染层（防止低层错误信息捲带
Cookie 元数据），统一包装为 `migration_inject_failed` 计数型错误。

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

同 v1，第 4/5/8 条表述与实现按 R2 修复后口径：

- #4 平台名字白名单：CDP 返回 → **同步**名字过滤 → 非白名单即弃（不做二次处理）；
- #5 值只在主进程：摘要/manifest/错误仅含计数、域名、Cookie 名（`SECRET-…` 注入测试断言序列化不含值）；底层异常包装后上抛；
- #8 回滚（WAL 语义）：pending 先行 → 每条 set 后立即登记账本 → 验证/提交失败自动回滚 → 回滚自身失败升级为 `migration_rollback_failed` 并留待启动恢复；显式回滚只动 manifest 列表。

## 4. 实现方自测（v4 修复后）

- `npm run check`：64 文件语法通过；
- `npm test`：**100 tests，99 pass / 0 fail / 1 skipped**（本轮新增 3 项冲突守卫测试）；
- 无头启动冒烟：daemon 监听、UI 初始化、Space partition 生成、自动退出正常。

## 5. 留给审计人的验收项（未变 + 新增）

1. `npm run package:mac` + `npm run test:packaged`（上次已过，本次改动后需重跑）；
2. 六平台真实登录迁移 + cookieNames 校准（Suno/公众号/抖音/小红书/快手/网易云）；
3. 回滚演练：同步 → 回滚 → 目标 Space 未登录态、其他数据无损；
4. 越权面复核：`git diff main..HEAD -- src/security src/server src/constants.mjs src/browser/auth-bridge.mjs src/browser/external-auth.mjs src/browser/chrome-launcher.mjs src/browser/cdp-session.mjs` 应为空；
5. 明文泄漏面复核（IPC 返回值 / manifest / 审计日志）；
6. **新增**：defaultSession → partition 迁移的架构变更评审（§2），及旧 Suno 会话是否需要自动搬迁；
7. **新增**：多 Space 并存浏览是否纳入本分支或后续工程（§2 已知边界）。

# GLM 任务书：Chrome Profile 迁移改造（beta.4 → 迁移向导）

> **v2 修订（Codex 定稿）**：范围收缩为六文件清单
> （`src/profile/chrome-profile-detector.mjs`、`src/profile/profile-migrator.mjs`、
> `src/browser/chrome-cdp.mjs`、`src/browser/auth-bridge.mjs`、`src/ui/migration-wizard.js`、
> `test/profile/**`）；方案 A 采纳但表述修正为"只在主进程内存短暂处理用户明确授权的
> 白名单 Cookie"；新增十条硬约束（CDP 触发时机、逐域勾选、Google 域永久禁止、
> 平台级 Cookie 白名单、明文不出主进程、同步后丢弃、前后验证、失败回滚、Agent 无
> 决定权、人工环节不变）。实现与自证见 `docs/CHANGES-profile-migration.md`。

> 本文件是 GLM 本次任务的唯一工作契约。所有需求的解释权、代码审计权和最终验收权归项目所有者（下称"审计人"）。
> **GLM 不得自行宣布完成。** GLM 的交付物是分支上的提交 + 自测报告，完成与否以审计人的审计报告为准。

---

## 0. 分支与提交纪律

- 工作分支：`glm/profile-migration`（已建好，从基线 `4cedd9e` 切出）。GLM 只在该分支上工作。
- 只做本地提交，小步提交（每个逻辑单元一个 commit，写清 commit message）。
- **禁止**：配置 remote、push、merge 到 main、rebase main、改写已有提交。
- 禁止修改 `.gitignore`，禁止在 `agent-chrome-lite/` 目录之外创建或修改任何文件。

## 1. 代码范围

### 允许修改 / 新建

| 路径 | 说明 |
| --- | --- |
| `src/profile/**` | **新建模块**（目前不存在）：Profile 探测、只读拷贝、manifest、回滚 |
| `src/browser/space-manager.mjs` | **新建**：Agent Space 分区管理 |
| `src/browser/tab-ownership.mjs` | **新建**：标签页归属判定 |
| `src/main.mjs` | 仅限接入迁移向导的最小改动（IPC 注册、窗口接线） |
| `src/ui/**` | 仅限迁移向导界面（向导页、勾选项、进度、回滚入口） |
| `test/profile/**`、`test/space/**` | **仅限新增**测试文件 |

### 禁止修改（包括"顺手重构"、改格式、改注释）

- `src/security/**` 整个目录（risk-policy、network-egress、platform-registry、contribution-policy）
- `src/server/daemon.mjs` 及 `src/server/**` 其余文件
- `src/constants.mjs` 中的 `CAPABILITIES` / `CONFIRMATION_POLICY` 等权限定义；**版本号也不要动**（beta.5 升级由审计人验收后统一执行，`constants.VERSION` 与 `package.json` 必须同步，有 `test/version.test.mjs` 校验）
- 发布 / 提交 / 支付拦截相关的一切逻辑
- **任何已存在的测试文件**（`test/*.test.mjs` 现有文件一律不碰，包括 `test/risk-policy.test.mjs`、`test/network-egress.test.mjs`、`test/version.test.mjs`）
- `src/browser/auth-bridge.mjs`、`external-auth.mjs`、`chrome-launcher.mjs`、`chrome-cdp.mjs`、`cdp-session.mjs`（现有会话桥是既定架构，只许复用、不许改）

## 2. 架构现状（必读，违反既定原则 = 直接打回）

- Electron 应用，`userData` = `runtime/profile`（`ABL_PROFILE_DIR` 可覆盖），见 `src/main.mjs` 约 35 行。
- 现有认证模型（**这是既定架构原则，迁移功能不得推翻**）：
  - `chrome-launcher.openInChrome()` 把 Google 登录交给系统真实 Chrome；
  - `auth-bridge.mjs` 只把 **Suno 域白名单 Cookie**（`__client` / `__session` / `__client_uat` / `__clerk_db_jwt`）回迁到 Electron cookie store；
  - `external-auth.mjs` 是窄白名单 URL 分类器。
  - 原则：**登录态归 Chrome 所有；Electron 侧只做最小化、白名单化的会话桥接。**
- 权限模型：`constants.CAPABILITIES` 冻结能力集；daemon 按 risk-policy 决策；`CONFIRMATION_POLICY = "handoff-only"`。
- 整档 Profile 迁移是**用户显式发起的本地操作**，白名单桥接仍是默认路径——两者关系必须在向导 UI 文案中讲清楚。

## 3. 功能需求

- **F1 探测**：检测本机 Chrome Profile（macOS `~/Library/Application Support/Google/Chrome/` 下的 `Default` 与 `Profile.*`），列出可迁移项；Chrome 正在运行且占用该 Profile 时（SingletonLock / lockfile）**拒绝迁移**并提示，防止拷到半写损坏状态。
- **F2 向导 UI**：逐项勾选（Cookies、localStorage 等；密码/自动填充/历史/扩展默认**不提供**迁移）。默认全部不选，最小化迁移。
- **F3 执行**：只读拷贝源文件 → 写入**独立于默认 userData 的 agent 分区目录** → 生成 `manifest`（来源路径、文件清单、SHA-256、时间戳、所选项）。
- **F4 回滚**：一键按 manifest 删除迁移产物，恢复迁移前状态；回滚不得依赖读取原 Profile。
- **F5 失败安全**：任何一步失败即中止，并回滚已写入内容；不允许存在"半迁移且无 manifest"的状态。
- **F6 Space 隔离**：`space-manager` / `tab-ownership` 保证迁移内容只进入指定 agent space；不同 space 的 Cookie 存储互不可见（用 Electron `partition` 隔离）。

## 4. 硬性架构约束（对应审计清单，违反任何一条 = 整体打回）

| # | 约束 | 对应审计点 |
| --- | --- | --- |
| C1 | 对原 Chrome Profile **只读**：只允许只读拷贝；不得 rename/写入/删除源目录任何文件；不得用 `--user-data-dir` 指向原 Profile 启动可写实例 | 审计 3 |
| C2 | **凭据安全**：`Login Data`（密码）、`Web Data`（自动填充）、`History` 不迁移也不解析；Cookie 内容不得出现在日志/错误信息/任何输出；不得有任何出网上传路径（network-egress 不许碰，其规则天然生效） | 审计 2 |
| C3 | **可回滚**：迁移产物 100% 落在独立目录 + manifest；一键完整回滚 | 审计 3 |
| C4 | **隔离**：迁移内容只进 agent space 分区；space 之间 Cookie/存储互不可见 | 审计 4 |
| C5 | **权限不动**：不注册新 capability、不绕过 daemon 确认链；迁移本身是本地人工操作，但**不得给 agent 自动触发迁移的能力** | 审计 5 |
| C6 | **人工强制不变**：人机验证、2FA、发布、支付路径零改动；向导遇到 challenge 页面只能提示用户人工处理 | 审计 6 |
| C7 | 拷贝完成后校验 SHA-256 与 manifest 一致，不一致按失败处理（触发 F5） | 审计 1、3 |

## 5. 测试要求

- `test/profile/**` 必须覆盖：C1 只读性（拷贝后源文件 hash/mtime 不变）、C2（密码库文件绝不出现在迁移清单）、C3（回滚后目录为空）、C7（manifest 校验）、F1（锁检测，mock）。
- `test/space/**` 必须覆盖：C4（两个 space Cookie 互不可见）、tab-ownership 归属判定。
- 一律用 fixture/mock，**测试中不得包含真实 Cookie 值或真实凭据**。
- 现有测试零回归。基线：`npm test` = **73 pass / 0 fail / 1 skipped**（基于 `4cedd9e`）。
- 可用命令：`npm test`、`npm run check`（语法检查）。打包冒烟 `npm run test:packaged` 与真实 Chrome 验收由审计人执行，GLM 不必跑。

## 6. 交付物（缺一不可）

1. `glm/profile-migration` 分支上的小步提交。
2. `docs/CHANGES-profile-migration.md`：变更文件清单 + 对 C1–C7 每条约束的实现位置与自证说明。
3. `npm test` 完整输出。
4. 结尾明确写："**以上交付待审计人审计，不自行合并、不推送、不宣布完成。**"

## 7. 即刻打回的红线示例

- diff 中出现 `src/security/**`、`src/server/**`、`src/constants.mjs` 权限定义的任何改动
- 迁移清单中出现 `Login Data`、`Web Data`、`History`、扩展目录
- 出现任何 `fetch`/`net`/上传调用、或在日志中输出 Cookie 值
- 以可写方式打开原 Chrome Profile
- 改动任何既有测试文件使其"适应"新代码

---

*任务书版本：v1（基线 `4cedd9e`，beta.4，测试基线 73/0/1）。任务书本身不入库，是否随仓库发布由审计人决定。*

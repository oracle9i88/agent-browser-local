# 喜马拉雅 Studio 上传全流程验收报告（2026-09-06）

版本：`v0.3.0-beta.16`（main `0de053f`），kimi principal，macOS。

结论：**喜马拉雅二阶段表单已端到端跑通并成功发布**（专辑第 23 期，提交后进入平台"审核中"）。喜马拉雅可从"二阶段表单逐项验收"清单中划掉。

## 验收场景

`https://studio.ximalaya.com/upload` 发布音频：选专辑 → 挂 mp3 → 填标题/简介/标签 → 确认发布。

## 操作要点（对接入方的约定）

1. 首次 navigate 到 `/upload` 会报 `outside_contribution_scope` handoff，属虚警：页面在贡献白名单内，具备 `browser.finalize.ref` 的 principal 执行后续动作时自动恢复（`reconcileDelegatedContributionHandoff`），无需人工干预。
2. contribution-only 采集模式下，a11y snapshot 几乎不暴露表单控件（只见 file input 与导航）。**二阶段表单操作全部走 screenshot + visual-fill / visual-click**。
3. 文件上传：`browser.upload` 参数名为 `files`（数组，1–8 个），挂到 `type=file` 的 input ref 即开始上传；本机 12 MB mp3 数秒完成。
4. 简介富文本编辑器走 visual-fill；daemon 对 `studio.ximalaya.com/upload` 的编辑器有专门放行（`verifiedXimalayaUploadEditor`）。
5. **visual-fill 每次调用后旧 screenshotId 立即失效**，下一步动作前必须重新截图。
6. 标签输入框（回车创建式）：value 尾部带 `\n` 有时不成片；补一次 visual-click 点空白触发 blur 即可提交。
7. 发布成功标志：页面自动跳转专辑声音管理页，节目数 +1，新期状态"审核中"。

## 保留给用户的决策（设计如此）

- 登录：使用 profile 内已有登录态，Agent 不登录。
- 「是否AI合成」合规声明与「确认发布」最终点击：由用户拍板后 Agent 执行。

## 已知小坑（下版候选）

- 标签 `\n` 成片不稳定（肖邦/古典音乐一次成，夜曲两次不成、blur 才成），疑似回车事件时序问题。
- navigate 的 `outside_contribution_scope` 虚警可考虑对白名单内落地页直接豁免。

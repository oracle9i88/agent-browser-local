# Agent Browser Local：P1 Preview 实施记录

日期：2026-08-08

版本：0.3.0

初始范围：macOS 本地应用化与安全启动。随后按用户授权追加真实账号投稿页的只读验收；不上传、不填写、不提交、不发布。

## 已完成

- 新增 macOS `.app` 离线构建脚本，复用项目已有 Electron 运行时，不下载新依赖。
- 应用使用名称 `Agent Browser Local`、Bundle ID `com.evanguo.agent-browser-local` 和独立图标。
- 运行包只包含 `src/` 与运行时依赖 `ws`；最终 `.app` 约 275MB。
- 删除 Electron 模板的摄像头、麦克风、蓝牙与 `NSAllowsArbitraryLoads` 权限声明。
- 生成后执行 ad-hoc 深度签名并使用 `codesign --verify --deep --strict` 验证。
- 增加单实例锁；重复启动只唤醒已有窗口，不创建第二个 daemon。
- daemon 端口冲突或其他启动故障会显示本地错误窗口，不再静默退出。
- UI 增加页面故障红色状态，说明登录资料仍然保留。
- UI 显示 daemon 启动状态和当前版本；页面故障时提供仅由用户点击的“恢复页面”按钮。
- 打包验收使用临时 Profile、随机回环端口、隐藏窗口和 `about:blank`；四个 principal 均存在，第二实例正确退出，验收后无残留进程。
- 每次打包生成 `release-manifest.json`，记录 ZIP 大小与 SHA-256；打包验收会先重新计算并核对清单。
- 新增 `npm run doctor` 只读体检：不读取 token 内容、不启动浏览器，检查配置/token 权限、Profile、daemon 安全绑定和打包产物哈希。

## 产物

- `agent-chrome-lite/dist/Agent Browser Local.app`
- `agent-chrome-lite/dist/Agent Browser Local-0.3.0-mac.zip`
- `agent-chrome-lite/dist/release-manifest.json`

以上 `dist/` 产物不纳入 Git，可由 `npm run package:mac` 重建。当前为本机自用的 ad-hoc 签名版本，尚未进行 Apple Developer ID 签名与公证。

## 网易云音乐边界

网易云音乐已进入代码中的 `PLATFORM_BACKLOG`。由于当前有另一位操作者正在真实提交，本次未打开、刷新、登录或探测网易云页面，也未把未经核验的路径写入 contribution allowlist。对方完成并明确交接后，才执行官方入口核验、Snapshot 验收与最终人工发布门配置。

## 真实投稿页验收

- 小红书：通过。两次进入 `https://creator.xiaohongshu.com/publish/publish` 后，Snapshot ID/ref 均重新生成，同时稳定找回原生文件输入、“上传视频”和“上传图文”；未使用旧 ref、固定选择器或坐标。
- 快手：通过。根据官方登录回调将 allowlist 从管理页收窄为 `https://cp.kuaishou.com/article/publish/video`。首次 Snapshot 暴露数据分析侧栏后立即停止，修复并重启；两次复验均只保留上传视频、上传图文、上传全景视频等贡献控件，数据/作品/粉丝分析导航不再返回。
- 抖音：未完成。官方投稿 URL 可进入，但页面内仍出现手机号与验证码登录层；未代填、未重试。由此新增“同 URL 登录表单”门禁，Snapshot 在返回控件前即冻结并 handoff。
- 微信公众号：验收中。新建图文 URL 可进入；页面内登录表单已被新增门禁拦截，等待用户登录后验证编辑器语义控件与重新发现性。
- 本轮没有上传文件、填写正文或点击最终提交/发布；没有打开 Suno/MIDI 或网易云音乐。

本轮发现并修复的两条线上缺口均已进入代码和自动化测试：同 URL 登录层的 daemon handoff，以及快手后台侧栏的 Snapshot 隐私过滤。

## 尚未完成

- 抖音登录后的投稿页 Snapshot 与重新发现性。
- 微信公众号登录后的编辑器 Snapshot 与重新发现性。
- 小红书/快手均未上传正式文件，因此上传后的标题、正文、封面、标签等二阶段表单尚未验收。
- 网易云音乐仍等待正在提交作品的其他操作者明确交接。
- 未操作 Suno/MIDI。
- 未安装到 `/Applications`。
- 未进行 Developer ID 签名、公证、自动更新或开机启动。

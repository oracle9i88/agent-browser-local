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
- 微信公众号：人工登录成功。直接构造编辑器 URL 时遗漏后台会话 `token`，触发重新登录；改为由用户从后台自然进入。用户截图随后证明真正编辑器打开在微信创建的新窗口，而 daemon 仍绑定后方文章列表，因此没有执行 Snapshot。已实现投稿弹窗路由：只将带完整会话上下文、且满足 contribution allowlist 的官方编辑器接回主受控页面；文章列表与外站弹窗不接管。为避免再次令微信会话失效，本轮不重启，线上复验留待下次自然启动，不能记作已通过。
- 本轮没有上传文件、填写正文或点击最终提交/发布；没有打开 Suno/MIDI 或网易云音乐。

本轮发现并修复的两条线上缺口均已进入代码和自动化测试：同 URL 登录层的 daemon handoff，以及快手后台侧栏的 Snapshot 隐私过滤。

微信公众号另暴露两条平台事实：编辑器 URL 必须保留由站内入口产生的完整 token/context，不能手工裁剪；编辑器可能由 `window.open` 创建独立窗口。两条均由用户实际页面和截图确认。

## 工具栏状态分叉事故

用户截图证明，页面窗口顶部只显示 HTML 初始占位“本地安全模式”，没有版本号，也没有 daemon 已要求的“我已接管”按钮。此前将该现象误判为用户尚未点击，导致用户执行了无效操作。

根因与修复：

- sandboxed Electron preload 使用了 `preload.mjs`；改为受支持的 CommonJS `preload.cjs`。
- IPC handler 原先在窗口加载完成后才注册；改为先注册 IPC，再创建窗口。
- 新增强制启动自检：先确认 preload bridge 存在，再确认工具栏渲染“daemon 启动中”，监听成功后确认显示 `v0.3.0`。任一步失败即终止启动并显示错误，禁止继续展示伪安全状态。
- 第一版自检把“daemon 已就绪”断言放在 `api.listen()` 之前，被打包验收正确拦下；随后拆为两阶段自检并重新打包，临时 Profile 的 packaged smoke 通过。

用户截图是该事故的决定性证据；在截图出现前，没有足够证据支持“用户未点击”的判断。

## 尚未完成

- 抖音登录后的投稿页 Snapshot 与重新发现性。
- 微信公众号编辑器 Snapshot 与重新发现性；投稿弹窗路由已有自动化测试，但尚未重启做真实页面复验。
- 小红书/快手均未上传正式文件，因此上传后的标题、正文、封面、标签等二阶段表单尚未验收。
- 网易云音乐仍等待正在提交作品的其他操作者明确交接。
- 未操作 Suno/MIDI。
- 未安装到 `/Applications`。
- 未进行 Developer ID 签名、公证、自动更新或开机启动。

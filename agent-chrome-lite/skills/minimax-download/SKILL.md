---
name: minimax-download
description: 在 Macian/Agent Browser Local 已登录的 MiniMax 音乐创作页，逐首下载用户指定的现成作品无水印 MP3，并核验本地文件；供 Kimi song-factory 等受本地授权的 Agent 使用。不是搜索、批量采集或生成歌曲流程。
---

# MiniMax 已有作品下载

用户本人先在 Macian 完成微信登录和平台协议确认；Agent 不碰登录、Cookie 或验证码。操作只限 `https://www.minimax.cn/audio/music` 中用户明确指定的作品。不要访问平台私有接口、遍历作品列表、抓取歌词或用固定 CSS/XPath/坐标。不同作品可**逐首重复**以下流程；“一次性许可”仅表示一次点击只接收一个相符 MP3，不是总下载次数限制。

1. 确认本地 `/v1/session` 返回的 principal 已由用户在本机授予 `browser.download.minimax` 和 `browser.download.status`；不得在 Agent 进程里自行改权限。当前 URL 必须是 MiniMax 音乐创作页，且无待处理 handoff。
2. 对照用户提供的歌曲名称和当前截图，在可见作品卡片上动态找到下载箭头；标题相同的多个版本需靠时长/画面/用户指定位置消歧。用当前截图生成的 visual ref 点击箭头。不要按顺序盲点，也不要在未确认作品时下载。
3. 菜单打开后，在 Kimi 已安全设置 `ABL_TOKEN` 的进程环境中运行：`node skills/minimax-download/scripts/download-open-menu.mjs --expected-title '歌曲名'`。脚本从**新 Snapshot**中要求恰好一个 `MP3(无水印)` 控件，点击后等下载记录完成，核对文件名、落盘字节数。`ABL_TOKEN` 从 Kimi 自己的本地密钥配置传入，不写入命令历史、日志或仓库；不要把真实 token 发给其他 Agent。
4. 脚本返回的 `savePath` 是文件位置；确认该路径里的 MP3 可解码，再交给后续制作。失败或超时先查 `/v1/actions/download-status`，不要在结果不明时重试点击，以免重复下载。

浏览器内置的安全门只在本地授权、当前页面、当前 `MP3(无水印)` 菜单项、MiniMax 音乐 CDN 的无水印 MP3 同时匹配时自动保存到 `~/Downloads`。其他下载仍由用户处理。若菜单未出现在 Snapshot，暂停并报告具体状态，不绕过权限层改用系统点击或直接抓 CDN URL。人机验证出现时交还用户。喜马拉雅 Profile 不涉及本流程，不要清理或重建。

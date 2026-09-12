# MiniMax 下载 skill 金样

输入：当前 `https://www.minimax.cn/audio/music`，用户指定可见作品《跟我隻槳》，该卡片下载菜单已打开；菜单中恰好一个 `MP3(无水印)` 和一个 `MP3(有水印)`。

复现纯函数门卫（无需登录、不会下载）：

```bash
node --test test/minimax-download-helper.test.mjs test/capture-series.test.mjs test/risk-policy.test.mjs test/capture-series-protocol.test.mjs
```

参考结果：所有测试通过。金样断言包括：一个无水印项可唯一选中；0/2 个无水印项拒绝；有水印项不命中；无本地权限不点击；一次许可只接受一次来自 `cdn.hailuoai.com` 的音乐 MP3，不接受伪造域、错误文件名或第二个文件。真实账号验收还须以下载状态 `completed`、本地文件可解码为准。

# NovaGe / NovaDe HTTP adapter

`agent_browser_client.py` 直接用 Python 标准库 HTTP 调本机 daemon，不引入 MCP 客户端、SDK 或额外依赖。

关键性质：

- 调用方只传动作参数，不传 `agentId`、capabilities 或 confirmation policy。
- principal 由各自固定入口选择，token 从 `~/.agent-browser-local/tokens.env` 读取。
- 服务地址只接受 `127.0.0.1` / `localhost` 的 HTTP loopback。
- 上传文件必须位于调用 Agent 自己的 workspace，不能借浏览器读取其他目录。
- 截图保存进该 Agent 自己的 workspace；其余响应原样返回 JSON。
- daemon 的贡献范围、危险动作和人工 handoff 门仍然生效，Adapter 无法绕过。

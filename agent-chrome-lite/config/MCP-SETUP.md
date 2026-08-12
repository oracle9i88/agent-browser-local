# Codex 与 Claude MCP 接入

两个入口都从 `~/.agent-browser-local/tokens.env` 读取各自固定 principal 的 token。配置里不保存明文 token，Agent 也不能在请求里声明或切换身份。

下文用 `PROJECT_DIR` 表示本仓库的绝对路径：

```bash
export PROJECT_DIR="/absolute/path/to/agent-browser-local"
```

## Codex

```bash
codex mcp add agent-browser -- \
  node "$PROJECT_DIR/bin/mcp-codex.mjs"
```

等价的 `config.toml`：

```toml
[mcp_servers.agent-browser]
command = "node"
args = ["/absolute/path/to/agent-browser-local/bin/mcp-codex.mjs"]
startup_timeout_sec = 10
tool_timeout_sec = 120
default_tools_approval_mode = "writes"
```

Codex App、CLI 与 IDE 扩展共享 `config.toml`。添加后重启对应客户端。

## Claude Code

```bash
claude mcp add --scope user agent-browser -- \
  node "$PROJECT_DIR/bin/mcp-claude.mjs"
```

添加后重新启动 Claude Code，再用 `claude mcp get agent-browser` 检查连接。

## 前置条件

先启动独立浏览器：

```bash
cd "$PROJECT_DIR"
npm start
```

MCP 只是一层薄壳；身份、权限、动作阻断、人类节奏和审计都由 daemon 决定。

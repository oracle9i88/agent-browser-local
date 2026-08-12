#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = process.env.ABL_TOKEN;
const entry = process.env.ABL_MCP_ENTRY || path.join(projectDir, "mcp", "server.mjs");
if (!token && !process.env.ABL_MCP_ENTRY) {
  throw new Error("ABL_TOKEN is required when testing the raw MCP server entry");
}

const client = new Client(
  { name: "agent-browser-mcp-smoke", version: "0.1.0" },
  { capabilities: {} },
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: projectDir,
  env: {
    ...process.env,
    ...(token ? { ABL_TOKEN: token } : {}),
    ABL_SERVER_URL: process.env.ABL_SERVER_URL || "http://127.0.0.1:3767",
  },
  stderr: "pipe",
});

await client.connect(transport);
const listed = await client.listTools();
const names = listed.tools.map((tool) => tool.name).sort();
const forbidden = names.filter((name) => /publish|submit|delete|pay|evaluate|script|selector/i.test(name));
if (forbidden.length) throw new Error(`Forbidden MCP tools exposed: ${forbidden.join(", ")}`);

const status = await client.callTool({ name: "browser_status", arguments: {} });
const snapshot = await client.callTool({ name: "browser_snapshot", arguments: {} });

console.log(
  JSON.stringify(
    {
      ok: true,
      tools: names,
      statusContent: status.content?.[0]?.type,
      snapshotContent: snapshot.content?.[0]?.type,
    },
    null,
    2,
  ),
);

await client.close();

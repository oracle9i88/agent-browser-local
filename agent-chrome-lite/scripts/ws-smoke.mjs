#!/usr/bin/env node

import WebSocket from "ws";

const baseUrl = process.env.ABL_WS_URL || "ws://127.0.0.1:3767/v1/ws";
const token = process.env.ABL_TOKEN;
if (!token) throw new Error("ABL_TOKEN is required for WebSocket smoke test");

const ws = new WebSocket(baseUrl, {
  headers: { authorization: `Bearer ${token}` },
});

const messages = [];
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("WebSocket smoke timeout")), 5000);
  ws.on("error", reject);
  ws.on("open", () => {
    ws.send(JSON.stringify({ id: "status-1", method: "browser.status", params: {} }));
  });
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    messages.push(message);
    const hasSession = messages.some((item) => item.type === "session" && item.principal === "codex");
    const hasStatus = messages.some((item) => item.id === "status-1" && item.ok === true);
    if (hasSession && hasStatus) {
      clearTimeout(timer);
      resolve();
    }
  });
});

console.log(JSON.stringify({ ok: true, messages }, null, 2));
ws.close();


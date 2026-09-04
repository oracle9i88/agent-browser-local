import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

import { hashToken } from "../src/config.mjs";
import {
  CONFIRMATION_POLICY,
  DEFAULT_CAPABILITIES,
} from "../src/constants.mjs";
import { createApiServer } from "../src/server/http-server.mjs";

const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function reserveLoopbackPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function waitForWsMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket test timeout")), 3000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
  });
}

const protocolTest = process.env.ABL_PROTOCOL_TEST === "1" ? test : test.skip;

protocolTest("HTTP, WebSocket and MCP adapters pass against an isolated daemon", async () => {
  const port = await reserveLoopbackPort();
  const token = "abl_offline_protocol_smoke_token_123456789";
  const config = {
    server: { host: "127.0.0.1", port },
    agents: [
      {
        principal: "codex",
        tokenSha256: hashToken(token),
        capabilities: [...DEFAULT_CAPABILITIES],
        confirmationPolicy: CONFIRMATION_POLICY,
      },
    ],
  };
  const controller = new EventEmitter();
  const status = {
    title: "Offline contribution form",
    url: "https://example.test/create",
    loading: false,
    handoff: null,
  };
  const daemon = {
    async dispatch(identity, method) {
      if (method === "session.get") {
        return {
          principal: identity.principal,
          capabilities: [...identity.capabilities],
          confirmationPolicy: identity.confirmationPolicy,
          constitution: "contribution-only",
        };
      }
      if (method === "browser.status") return status;
      if (method === "browser.snapshot") {
        return {
          snapshotId: "offline01",
          title: status.title,
          url: status.url,
          controls: [],
          hints: [],
          limits: { collectionMode: "contribution-only" },
        };
      }
      if (method === "browser.scroll") {
        return {
          ok: true,
          direction: "down",
          amount: "bottom",
          steps: 3,
          reachedEnd: true,
          deltaY: 1920,
        };
      }
      if (method === "browser.captureSeries") {
        return {
          captureId: "offline-cap-1",
          label: "Tragic Grandeur",
          dirName: "Tragic Grandeur-20260904",
          shotCount: 4,
          reachedEnd: true,
          stopReason: "reached_end",
          shots: [],
        };
      }
      if (method === "browser.downloadStatus") {
        return {
          downloads: [
            {
              downloadId: "dl_alpha",
              filename: "stems.wav",
              savePath: "/tmp/stems.wav",
              state: "completed",
              finishedAt: 1,
              receivedBytes: 1024,
              totalBytes: 1024,
            },
          ],
          count: 1,
        };
      }
      throw new Error(`Unexpected offline method: ${method}`);
    },
  };
  const api = createApiServer({ daemon, config, controller });
  await api.listen();

  let ws;
  let client;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result, status);

    ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const sessionMessage = await waitForWsMessage(
      ws,
      (message) => message.type === "session",
    );
    assert.equal(sessionMessage.principal, "codex");
    ws.send(JSON.stringify({ id: "status-1", method: "browser.status" }));
    const statusMessage = await waitForWsMessage(
      ws,
      (message) => message.id === "status-1",
    );
    assert.equal(statusMessage.ok, true);
    assert.deepEqual(statusMessage.result, status);

    client = new Client(
      { name: "offline-agent-browser-test", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(projectDir, "mcp", "server.mjs")],
      cwd: projectDir,
      env: {
        ...process.env,
        ABL_TOKEN: token,
        ABL_SERVER_URL: `http://127.0.0.1:${port}`,
      },
      stderr: "pipe",
    });
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.equal(names.length, 14);
    assert.deepEqual(
      names.filter((name) =>
        /publish|submit|delete|pay|evaluate|script|selector/i.test(name),
      ),
      [],
    );
    const mcpStatus = await client.callTool({
      name: "browser_status",
      arguments: {},
    });
    assert.equal(mcpStatus.content?.[0]?.type, "text");
    assert.match(mcpStatus.content[0].text, /Offline contribution form/);
    const mcpSnapshot = await client.callTool({
      name: "browser_snapshot",
      arguments: {},
    });
    assert.match(mcpSnapshot.content[0].text, /contribution-only/);
    const mcpScroll = await client.callTool({
      name: "browser_scroll",
      arguments: { direction: "down", amount: "bottom" },
    });
    assert.match(mcpScroll.content[0].text, /"direction": "down"/);
    assert.match(mcpScroll.content[0].text, /"reachedEnd": true/);

    const mcpCapture = await client.callTool({
      name: "browser_capture_series",
      arguments: {
        label: "Tragic Grandeur",
        maxShots: 4,
        anchor: { kind: "coords", x: 0.18, y: 0.5 },
      },
    });
    assert.match(mcpCapture.content[0].text, /"dirName": "Tragic Grandeur-20260904"/);
    assert.match(mcpCapture.content[0].text, /"stopReason": "reached_end"/);

    const mcpDownloads = await client.callTool({
      name: "browser_download_status",
      arguments: { includeCompleted: true },
    });
    assert.match(mcpDownloads.content[0].text, /"downloadId": "dl_alpha"/);
    assert.match(mcpDownloads.content[0].text, /"filename": "stems\.wav"/);

    // HTTP 直连：captureSeries / downloadStatus 也必须经 daemon dispatch
    const captureResponse = await fetch(
      `http://127.0.0.1:${port}/v1/actions/capture-series`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "Tragic Grandeur", maxShots: 4 }),
      },
    );
    assert.equal(captureResponse.status, 200);
    const captureJson = await captureResponse.json();
    assert.equal(captureJson.result.captureId, "offline-cap-1");

    const downloadResponse = await fetch(
      `http://127.0.0.1:${port}/v1/actions/download-status`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ includeCompleted: true }),
      },
    );
    assert.equal(downloadResponse.status, 200);
    const downloadJson = await downloadResponse.json();
    assert.equal(downloadJson.result.count, 1);
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (ws) {
      ws.close();
      await new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve();
        ws.once("close", resolve);
      });
    }
    await api.close();
  }
});

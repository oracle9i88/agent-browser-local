import http from "node:http";

import { WebSocketServer } from "ws";

import { authenticateToken } from "../config.mjs";
import { PRODUCT_NAME, VERSION } from "../constants.mjs";
import { DaemonError } from "./daemon.mjs";

const HTTP_ROUTES = new Map([
  ["GET /v1/session", ["session.get", () => ({})]],
  ["GET /v1/status", ["browser.status", () => ({})]],
  ["POST /v1/navigate", ["browser.navigate", (body) => body]],
  ["POST /v1/snapshot", ["browser.snapshot", () => ({})]],
  ["POST /v1/screenshot", ["browser.screenshot", () => ({})]],
  ["POST /v1/actions/click", ["browser.click", (body) => body]],
  ["POST /v1/actions/visual-click", ["browser.clickVisual", (body) => body]],
  ["POST /v1/actions/fill", ["browser.fill", (body) => body]],
  ["POST /v1/actions/upload", ["browser.upload", (body) => body]],
  ["POST /v1/handoff", ["browser.handoff", (body) => body]],
]);

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function validHost(req, configuredPort) {
  const host = String(req.headers.host || "").toLowerCase();
  return new Set([
    `127.0.0.1:${configuredPort}`,
    `localhost:${configuredPort}`,
    "127.0.0.1",
    "localhost",
  ]).has(host);
}

function bearer(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  return match?.[1] || null;
}

async function bodyJson(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new DaemonError(413, "body_too_large", "Request body is too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DaemonError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function errorPayload(error) {
  return {
    error: {
      code: error.code || "internal_error",
      message: error.message || "Internal error",
      ...(error.detail ? { detail: error.detail } : {}),
    },
  };
}

function errorStatus(error) {
  if (error instanceof DaemonError) return error.status;
  if (["stale_ref", "stale_visual_ref"].includes(error?.code)) return 409;
  return 500;
}

export function createApiServer({ daemon, config, controller }) {
  const clients = new Set();
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer(async (req, res) => {
    try {
      if (!validHost(req, config.server.port)) {
        throw new DaemonError(400, "invalid_host", "Invalid Host header");
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          product: PRODUCT_NAME,
          version: VERSION,
          binding: "loopback-only",
        });
      }
      const identity = authenticateToken(config, bearer(req));
      if (!identity) {
        throw new DaemonError(401, "unauthorized", "Missing or invalid bearer token");
      }
      const route = HTTP_ROUTES.get(`${req.method} ${url.pathname}`);
      if (!route) throw new DaemonError(404, "not_found", "Endpoint not found");
      const [method, paramsFromBody] = route;
      const body = req.method === "POST" ? await bodyJson(req) : {};
      const result = await daemon.dispatch(identity, method, paramsFromBody(body));
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, errorStatus(error), errorPayload(error));
    }
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      if (!validHost(req, config.server.port)) throw new Error("invalid host");
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== "/v1/ws") throw new Error("invalid path");
      const identity = authenticateToken(config, bearer(req));
      if (!identity) throw new Error("unauthorized");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, identity);
      });
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  wss.on("connection", (ws, _req, identity) => {
    const client = { ws, identity };
    clients.add(client);
    ws.send(
      JSON.stringify({
        type: "session",
        principal: identity.principal,
        capabilities: identity.capabilities,
        confirmationPolicy: identity.confirmationPolicy,
      }),
    );
    ws.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
        const result = await daemon.dispatch(
          identity,
          String(message.method || ""),
          message.params || {},
        );
        ws.send(JSON.stringify({ id: message.id, ok: true, result }));
      } catch (error) {
        ws.send(
          JSON.stringify({
            id: message?.id,
            ok: false,
            ...errorPayload(error),
          }),
        );
      }
    });
    ws.on("close", () => clients.delete(client));
  });

  const broadcast = (event, payload) => {
    const message = JSON.stringify({ type: "event", event, payload });
    for (const { ws } of clients) {
      if (ws.readyState === ws.OPEN) ws.send(message);
    }
  };
  controller.on("state", (state) => broadcast("browser.state", state));
  controller.on("handoff", (handoff) => broadcast("browser.handoff", handoff));

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.server.port, config.server.host, resolve);
      });
      return server.address();
    },
    async close() {
      for (const { ws } of clients) ws.close();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

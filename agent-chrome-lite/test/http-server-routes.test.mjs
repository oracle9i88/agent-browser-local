import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createApiServer } from "../src/server/http-server.mjs";
import { CAPABILITIES, CONFIRMATION_POLICY } from "../src/constants.mjs";

const TOKEN = "abl_test_token_for_route_aliases_0123456789";
const PORT = 18765;

function serverFixture(port = PORT) {
  const calls = [];
  const daemon = {
    dispatch: async (_identity, method) => {
      calls.push(method);
      return { method };
    },
  };
  const controller = { on() {} };
  const config = {
    server: { port, host: "127.0.0.1" },
    agents: [
      {
        principal: "glm",
        tokenSha256: createHash("sha256").update(TOKEN).digest("hex"),
        capabilities: [CAPABILITIES.STATUS],
        confirmationPolicy: CONFIRMATION_POLICY,
      },
    ],
  };
  const api = createApiServer({ daemon, config, controller });
  return { api, calls };
}

test("read-only endpoints accept both GET and POST", async (t) => {
  const { api, calls } = serverFixture();
  await api.listen();
  t.after(() => api.close());

  for (const [method, path] of [
    ["GET", "/v1/status"],
    ["POST", "/v1/status"],
    ["GET", "/v1/session"],
    ["POST", "/v1/session"],
  ]) {
    const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200, `${method} ${path}`);
    const body = await response.json();
    assert.equal(body.ok, true);
  }
  assert.deepEqual(calls, [
    "browser.status",
    "browser.status",
    "session.get",
    "session.get",
  ]);
});

test("unknown endpoints still return not_found", async (t) => {
  const port = PORT + 1;
  const { api } = serverFixture(port);
  await api.listen();
  t.after(() => api.close());

  const response = await fetch(`http://127.0.0.1:${port}/v1/nope`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "not_found");
});

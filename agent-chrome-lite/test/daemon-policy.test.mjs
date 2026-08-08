import test from "node:test";
import assert from "node:assert/strict";

import { BrowserDaemon, DaemonError } from "../src/server/daemon.mjs";
import { CAPABILITIES, CONFIRMATION_POLICY } from "../src/constants.mjs";

function fixture(node) {
  const events = [];
  const controller = {
    handoff: null,
    status() {
      return {
        url: "https://example.test/create",
        handoff: this.handoff,
      };
    },
    resolveRef: () => ({ backendNodeId: 1, node }),
    setHandoff(reason, detail) {
      this.handoff = { required: true, reason, detail };
      return this.handoff;
    },
    clickRef: async () => {
      throw new Error("click must not execute");
    },
    fillRef: async () => ({ ok: true }),
    snapshot: async () => ({
      snapshotId: "snapshot01",
      url: "https://example.test/create",
      controls: [],
      hints: [],
    }),
  };
  const daemon = new BrowserDaemon({
    controller,
    config: {
      security: {
        uploadRoots: [],
        contributionTargets: [
          { origin: "https://example.test", pathPrefixes: ["/create"] },
        ],
      },
    },
    executor: { run: (task) => task() },
    audit: { record: async (event) => events.push(event) },
  });
  const identity = {
    principal: "codex",
    capabilities: [CAPABILITIES.CLICK],
    confirmationPolicy: CONFIRMATION_POLICY,
  };
  return { controller, daemon, events, identity };
}

test("daemon blocks irreversible controls before browser dispatch", async () => {
  const { controller, daemon, events, identity } = fixture({
    tag: "button",
    role: "button",
    type: "submit",
    name: "创建",
  });

  await assert.rejects(
    daemon.dispatch(identity, "browser.click", { ref: "fresh:1" }),
    (error) =>
      error instanceof DaemonError &&
      error.status === 409 &&
      error.code === "irreversible_action_requires_handoff",
  );
  assert.equal(controller.handoff.required, true);
  assert.equal(events[0].event, "action.blocked");
});

test("agent cannot gain a capability by putting it in params", async () => {
  const { daemon, identity } = fixture({
    tag: "input",
    type: "text",
    role: "textbox",
  });
  await assert.rejects(
    daemon.dispatch(identity, "browser.fill", {
      ref: "fresh:1",
      value: "hello",
      capabilities: [CAPABILITIES.FILL],
    }),
    (error) => error.code === "capability_denied",
  );
});

test("pending handoff freezes browser automation until the human clears it", async () => {
  const { controller, daemon, identity } = fixture({
    tag: "button",
    role: "button",
    type: "button",
    name: "继续编辑",
  });
  controller.handoff = {
    required: true,
    reason: "用户正在登录",
    detail: { code: "outside_contribution_scope" },
  };

  await assert.rejects(
    daemon.dispatch(identity, "browser.click", { ref: "fresh:1" }),
    (error) =>
      error instanceof DaemonError &&
      error.status === 409 &&
      error.code === "handoff_pending",
  );
});

test("snapshot freezes automation when an in-page login surface keeps an allowed URL", async () => {
  const { controller, daemon, events, identity } = fixture({
    tag: "input",
    type: "text",
    role: "textbox",
  });
  identity.capabilities.push(CAPABILITIES.SNAPSHOT);
  controller.snapshot = async () => ({
    snapshotId: "login01",
    url: "https://example.test/create",
    controls: [
      {
        ref: "login01:1",
        tag: "input",
        type: "tel",
        role: "textbox",
        placeholder: "请输入验证码",
      },
    ],
    hints: [],
  });

  await assert.rejects(
    daemon.dispatch(identity, "browser.snapshot"),
    (error) =>
      error instanceof DaemonError &&
      error.status === 409 &&
      error.code === "manual_auth_surface_requires_handoff",
  );
  assert.equal(controller.handoff.required, true);
  assert.equal(events[0].event, "action.blocked");
  assert.equal(events[0].action, "snapshot");
});

test("fill audit never copies content-derived accessibility names", async () => {
  const secret = "第一段：不应进入审计的正文";
  const { daemon, events, identity } = fixture({
    tag: "div",
    role: "textbox",
    name: secret,
    contentEditable: true,
  });
  identity.capabilities.push(CAPABILITIES.FILL);

  await daemon.dispatch(identity, "browser.fill", {
    ref: "fresh:1",
    value: secret,
  });

  assert.equal(events[0].field, "textbox");
  assert.equal(events[0].name, undefined);
  assert.equal(events[0].value, secret);
});

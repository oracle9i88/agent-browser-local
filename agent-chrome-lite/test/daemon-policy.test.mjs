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
    lastResolveVisualOptions: null,
    resolveVisualPoint: async function (_params, options) {
      this.lastResolveVisualOptions = options || null;
      return {
        point: { x: 900, y: 422 },
        node,
      };
    },
    setHandoff(reason, detail) {
      this.handoff = { required: true, reason, detail };
      return this.handoff;
    },
    clearHandoff() {
      this.handoff = null;
      return null;
    },
    clickCount: 0,
    lastClickOptions: null,
    clickRef: async function (_ref, options) {
      this.clickCount += 1;
      this.lastClickOptions = options;
      return { ok: true };
    },
    clickVisual: async function (_point, options) {
      this.clickCount += 1;
      this.lastClickOptions = options;
      return { ok: true };
    },
    scrollCount: 0,
    scroll: async function ({ direction, amount }) {
      this.scrollCount += 1;
      return {
        ok: true,
        direction,
        amount,
        steps: amount === "bottom" ? 3 : 1,
        reachedEnd: amount === "bottom",
        deltaY: amount === "bottom" ? 1920 : 640,
      };
    },
    fillRef: async () => ({ ok: true }),
    fillVisualPoint: async () => ({ ok: true }),
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
  assert.equal(controller.clickCount, 0);
  assert.equal(events[0].event, "action.blocked");
});

test("locally granted finalize capability permits and audits publishing", async () => {
  const { controller, daemon, events, identity } = fixture({
    tag: "button",
    role: "button",
    type: "submit",
    name: "创建",
  });
  identity.capabilities.push(CAPABILITIES.FINALIZE);

  await daemon.dispatch(identity, "browser.click", { ref: "fresh:1" });

  assert.equal(controller.clickCount, 1);
  assert.equal(controller.handoff, null);
  assert.equal(events[0].event, "action.delegated");
  assert.equal(events[0].capability, CAPABILITIES.FINALIZE);
  assert.equal(events[1].event, "browser.click");
});

test("locally granted finalize capability also permits visual publishing", async () => {
  const { controller, daemon, events, identity } = fixture({
    tag: "button",
    role: "button",
    type: "submit",
    name: "确认发布",
  });
  identity.capabilities.push(CAPABILITIES.CLICK_VISUAL, CAPABILITIES.FINALIZE);

  await daemon.dispatch(identity, "browser.clickVisual", {
    screenshotId: "fresh-visual-1",
    x: 900,
    y: 422,
  });

  assert.equal(controller.clickCount, 1);
  assert.equal(controller.handoff, null);
  assert.equal(events[0].event, "action.delegated");
  assert.equal(events[0].capability, CAPABILITIES.FINALIZE);
  assert.equal(events[1].event, "browser.clickVisual");
});

test("Ximalaya iframe publish needs local finalize, one fresh lookup, and audit", async () => {
  const { controller, daemon, identity, events } = fixture({});
  controller.status = function () {
    return { url: "https://studio.ximalaya.com/upload", handoff: this.handoff };
  };
  daemon.config.security.contributionTargets.push({
    origin: "https://studio.ximalaya.com", pathPrefixes: ["/upload"],
  }, {
    origin: "https://www.ximalaya.com", pathPrefixes: ["/reform-upload"],
  });
  let inspections = 0;
  controller.inspectXimalayaPublish = async () => {
    inspections += 1;
    return {
      frameUrl: "https://www.ximalaya.com/reform-upload/page/webCenter/upload",
      node: { tag: "button", role: "button", name: "确认发布" },
    };
  };
  controller.clickXimalayaPublish = async () => ({ ok: true, result: "click_dispatched_verify_publication" });
  identity.capabilities.push(CAPABILITIES.SNAPSHOT);

  const ready = await daemon.dispatch(identity, "browser.inspectXimalayaPublish");
  assert.equal(ready.ready, true);
  await assert.rejects(daemon.dispatch(identity, "browser.clickXimalayaPublish"),
    (error) => error.code === "irreversible_action_requires_handoff");
  assert.equal(events.some((event) => event.event === "browser.clickXimalayaPublish"), false);
  controller.clearHandoff();
  identity.capabilities.push(CAPABILITIES.FINALIZE);
  const result = await daemon.dispatch(identity, "browser.clickXimalayaPublish");
  assert.equal(result.result, "click_dispatched_verify_publication");
  assert.equal(inspections, 3);
  assert.equal(events.at(-2).event, "action.delegated");
  assert.equal(events.at(-1).event, "browser.clickXimalayaPublish");
});

test("semantic and visual clicks forward an audited right mouse button", async () => {
  const semantic = fixture({ tag: "span", role: "button", name: "Audio clip" });
  await semantic.daemon.dispatch(semantic.identity, "browser.click", {
    ref: "fresh:1",
    mouseButton: "right",
  });
  assert.deepEqual(semantic.controller.lastClickOptions, { mouseButton: "right" });
  assert.equal(semantic.events.at(-1).mouseButton, "right");

  const visual = fixture({ tag: "div", role: "button", name: "Audio clip" });
  visual.identity.capabilities.push(CAPABILITIES.CLICK_VISUAL);
  await visual.daemon.dispatch(visual.identity, "browser.clickVisual", {
    screenshotId: "fresh-visual-1",
    x: 900,
    y: 422,
    mouseButton: "right",
  });
  assert.deepEqual(visual.controller.lastClickOptions, { mouseButton: "right" });
  assert.equal(visual.controller.lastResolveVisualOptions, null);
  assert.equal(visual.events.at(-1).mouseButton, "right");
});

test("only visual fill enables editable-descendant promotion", async () => {
  const { controller, daemon, identity } = fixture({
    tag: "textarea",
    role: "textbox",
    name: "Show Notes",
  });
  identity.capabilities.push(CAPABILITIES.CLICK_VISUAL, CAPABILITIES.FILL);
  await daemon.dispatch(identity, "browser.fillVisual", {
    screenshotId: "fresh-visual-1",
    x: 900,
    y: 422,
    value: "paragraph",
  });
  assert.deepEqual(controller.lastResolveVisualOptions, {
    promoteEditable: true,
  });
});

test("finalize capability never authorizes deletion or payment", async () => {
  const { controller, daemon, identity } = fixture({
    tag: "button",
    role: "button",
    name: "删除",
  });
  identity.capabilities.push(CAPABILITIES.FINALIZE);

  await assert.rejects(
    daemon.dispatch(identity, "browser.click", { ref: "fresh:1" }),
    (error) => error.code === "destructive_action_requires_handoff",
  );
  assert.equal(controller.clickCount, 0);
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

test("daemon permits only bounded audited scrolling on contribution pages", async () => {
  const { controller, daemon, events, identity } = fixture({
    tag: "body",
    role: "document",
  });
  identity.capabilities.push(CAPABILITIES.SCROLL);

  const result = await daemon.dispatch(identity, "browser.scroll", {
    direction: "down",
    amount: "page",
  });

  assert.equal(result.ok, true);
  assert.equal(controller.scrollCount, 1);
  assert.equal(events[0].event, "browser.scroll");
  assert.equal(events[0].direction, "down");
  assert.equal(events[0].amount, "page");
  assert.equal(events[0].url, "https://example.test/create");

  const bottom = await daemon.dispatch(identity, "browser.scroll", {
    direction: "down",
    amount: "bottom",
  });
  assert.equal(bottom.reachedEnd, true);
  assert.equal(bottom.steps, 3);
  assert.equal(controller.scrollCount, 2);
});

test("daemon rejects unbounded or ambiguous scroll requests", async () => {
  const { controller, daemon, identity } = fixture({
    tag: "body",
    role: "document",
  });
  identity.capabilities.push(CAPABILITIES.SCROLL);

  await assert.rejects(
    daemon.dispatch(identity, "browser.scroll", {
      direction: "bottom",
      amount: "all",
    }),
    (error) =>
      error instanceof DaemonError &&
      error.status === 400 &&
      error.code === "invalid_scroll_direction",
  );
  assert.equal(controller.scrollCount, 0);

  await assert.rejects(
    daemon.dispatch(identity, "browser.scroll", {
      direction: "up",
      amount: "bottom",
    }),
    (error) => error.code === "invalid_scroll_combination",
  );
  assert.equal(controller.scrollCount, 0);
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

test("finalize principal auto-resumes an outside-scope redirect after it returns to contribution scope", async () => {
  const { controller, daemon, events, identity } = fixture({
    tag: "input",
    type: "text",
    role: "textbox",
  });
  identity.capabilities.push(CAPABILITIES.SNAPSHOT, CAPABILITIES.FINALIZE);
  controller.handoff = {
    required: true,
    reason: "页面离开投稿范围",
    detail: { code: "outside_contribution_scope" },
  };

  await daemon.dispatch(identity, "browser.snapshot");

  assert.equal(controller.handoff, null);
  assert.equal(events[0].event, "handoff.auto_resumed");
  assert.equal(events[1].event, "browser.snapshot");
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

function navigateFixture({ handoffCode } = {}) {
  const events = [];
  const controller = {
    handoff: handoffCode
      ? { required: true, reason: "需要用户接管", detail: { code: handoffCode } }
      : null,
    navigateCount: 0,
    status() {
      return { url: "https://outside.example/", handoff: this.handoff };
    },
    clearHandoff() {
      this.handoff = null;
    },
    navigate: async function (url) {
      this.navigateCount += 1;
      this.handoff = null;
      return { url };
    },
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
    principal: "glm",
    capabilities: [CAPABILITIES.NAVIGATE],
    confirmationPolicy: CONFIRMATION_POLICY,
  };
  return { controller, daemon, events, identity };
}

test("navigate auto-resumes an outside-contribution-scope handoff when the target is in scope", async () => {
  const { controller, daemon, events, identity } = navigateFixture({
    handoffCode: "outside_contribution_scope",
  });

  const result = await daemon.dispatch(identity, "browser.navigate", {
    url: "https://example.test/create",
  });

  assert.equal(result.url, "https://example.test/create");
  assert.equal(controller.navigateCount, 1);
  assert.equal(controller.handoff, null);
  assert.equal(events[0].event, "handoff.auto_resumed");
  assert.equal(events[0].via, "browser.navigate");
});

test("queued recovery keeps the handoff until its navigation starts", async () => {
  const { controller, daemon, identity } = navigateFixture({
    handoffCode: "outside_contribution_scope",
  });
  let startQueuedAction;
  daemon.executor = {
    run: (task) => new Promise((resolve, reject) => {
      startQueuedAction = () => Promise.resolve().then(task).then(resolve, reject);
    }),
  };

  const navigation = daemon.dispatch(identity, "browser.navigate", {
    url: "https://example.test/create",
  });
  assert.equal(controller.handoff?.detail?.code, "outside_contribution_scope");
  assert.equal(controller.navigateCount, 0);

  await startQueuedAction();
  await navigation;
  assert.equal(controller.handoff, null);
  assert.equal(controller.navigateCount, 1);
});

test("navigate still blocks on handoffs that require human attention", async () => {
  const { controller, daemon, identity } = navigateFixture({
    handoffCode: "page_unavailable",
  });

  await assert.rejects(
    daemon.dispatch(identity, "browser.navigate", {
      url: "https://example.test/create",
    }),
    (error) =>
      error instanceof DaemonError &&
      error.status === 409 &&
      error.code === "handoff_pending",
  );
  assert.equal(controller.navigateCount, 0);
});

test("navigate to an out-of-scope target is rejected even with a pending scope handoff", async () => {
  const { controller, daemon, identity } = navigateFixture({
    handoffCode: "outside_contribution_scope",
  });

  await assert.rejects(
    daemon.dispatch(identity, "browser.navigate", {
      url: "https://outside.example/",
    }),
    (error) => error instanceof DaemonError && error.status === 403,
  );
  assert.equal(controller.navigateCount, 0);
});

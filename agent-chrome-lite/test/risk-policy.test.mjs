import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyAction,
  classifySnapshotSurface,
} from "../src/security/risk-policy.mjs";

test("blocks final submit and publish controls", () => {
  for (const node of [
    { tag: "button", role: "button", type: "submit", name: "创建" },
    { tag: "button", role: "button", name: "Publish" },
    { tag: "button", role: "menuitem", name: "Move to Trash" },
  ]) {
    assert.equal(classifyAction({ action: "click", node }).blocked, true);
  }
});

test("blocks platform-specific final buttons named 发表 or 上传", () => {
  for (const name of ["发表", "上传", "上传作品"]) {
    const risk = classifyAction({
      action: "click",
      node: { role: "button", tag: "button", type: "button", name },
      url: "https://example.test/create",
    });
    assert.equal(risk.blocked, true, name);
    assert.equal(risk.code, "irreversible_action_requires_handoff", name);
  }
});

test("dedicated upload action still accepts a semantic 上传 ref", () => {
  const risk = classifyAction({
    action: "upload",
    node: { role: "upload", name: "点击上传音频" },
    url: "https://example.test/create",
  });
  assert.equal(risk.blocked, false);
});

test("blocks originality declarations for human confirmation", () => {
  const risk = classifyAction({
    action: "click",
    node: {
      role: "checkbox",
      name: "声明后，作品将展示原创标记，有机会获得广告收入。",
    },
    url: "https://channels.weixin.qq.com/platform/post/create",
  });
  assert.equal(risk.blocked, true);
  assert.equal(risk.code, "legal_consent_required");
});

test("blocks Suno credit actions", () => {
  const risk = classifyAction({
    action: "click",
    node: { tag: "button", role: "button", name: "Get Stems / MIDI Pro" },
  });
  assert.equal(risk.blocked, true);
  assert.equal(risk.code, "credit_action_requires_handoff");
});

test("allows navigation links named Create", () => {
  const risk = classifyAction({
    action: "click",
    node: { tag: "a", role: "link", name: "Create", href: "/create" },
  });
  assert.equal(risk.blocked, false);
});

test("blocks credentials and verification fields", () => {
  for (const node of [
    { tag: "input", role: "textbox", type: "password", name: "Password" },
    { tag: "input", role: "textbox", autocomplete: "one-time-code" },
    { tag: "input", role: "textbox", name: "验证码" },
  ]) {
    assert.equal(classifyAction({ action: "fill", node }).blocked, true);
  }
});

test("same-URL login surfaces trigger handoff before snapshot data is returned", () => {
  const risk = classifySnapshotSurface({
    controls: [
      {
        tag: "input",
        type: "tel",
        role: "textbox",
        placeholder: "请输入验证码",
      },
    ],
  });
  assert.equal(risk.blocked, true);
  assert.equal(risk.code, "manual_auth_surface_requires_handoff");
});

test("ordinary contribution fields do not look like an auth surface", () => {
  const risk = classifySnapshotSurface({
    controls: [
      {
        tag: "input",
        type: "text",
        role: "textbox",
        placeholder: "请输入作品标题",
      },
    ],
  });
  assert.equal(risk.blocked, false);
});

test("only native file inputs or verified semantic upload triggers are upload targets", () => {
  assert.equal(
    classifyAction({
      action: "upload",
      node: { tag: "input", type: "file", role: "button" },
    }).blocked,
    false,
  );
  assert.equal(
    classifyAction({
      action: "upload",
      node: { tag: "span", role: "upload", name: "点击上传" },
    }).blocked,
    false,
  );
  assert.equal(
    classifyAction({
      action: "upload",
      node: { tag: "button", role: "button", name: "Upload" },
    }).blocked,
    true,
  );
});

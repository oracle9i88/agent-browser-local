import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyAction,
  classifySnapshotSurface,
} from "../src/security/risk-policy.mjs";
import { CAPABILITIES } from "../src/constants.mjs";

test("blocks final submit and publish controls", () => {
  for (const node of [
    { tag: "button", role: "button", type: "submit", name: "创建" },
    { tag: "button", role: "button", name: "Publish" },
    { tag: "button", role: "menuitem", name: "Move to Trash" },
  ]) {
    assert.equal(classifyAction({ action: "click", node }).blocked, true);
  }
});

test("final submit and legal consent expose only the local finalize capability", () => {
  for (const node of [
    { tag: "button", role: "button", type: "submit", name: "创建" },
    { tag: "input", role: "checkbox", name: "阅读并同意平台协议" },
  ]) {
    const risk = classifyAction({ action: "click", node });
    assert.equal(risk.blocked, true);
    assert.equal(risk.delegableCapability, "browser.finalize.ref");
  }
});

test("deletion and payment can never use delegated finalize", () => {
  for (const name of ["删除", "支付", "Confirm order"]) {
    const risk = classifyAction({
      action: "click",
      node: { tag: "button", role: "button", name },
    });
    assert.equal(risk.blocked, true, name);
    assert.equal(risk.code, "destructive_action_requires_handoff", name);
    assert.equal(risk.delegableCapability, undefined, name);
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

test("Suno generation actions are delegable via the credits capability", () => {
  const risk = classifyAction({
    action: "click",
    node: { tag: "button", role: "button", name: "Create Song" },
  });
  assert.equal(risk.blocked, true);
  assert.equal(risk.code, "credit_action_requires_handoff");
  assert.equal(risk.delegableCapability, CAPABILITIES.CREDITS_SUNO);
});

test("Get Stems/MIDI is not assigned a synthetic handoff gate", () => {
  const risk = classifyAction({
    action: "click",
    node: { tag: "button", role: "button", name: "Get Stems / MIDI Pro" },
    url: "https://suno.com/studio/song/abc",
  });
  assert.deepEqual(risk, { blocked: false });
});

test("Get Stems/MIDI with an explicit credit quote uses delegated credits", () => {
  const risk = classifyAction({
    action: "click",
    node: {
      tag: "button",
      role: "button",
      name: "Get Stems / MIDI Pro 50 credits",
    },
    url: "https://suno.com/studio/song/abc",
  });
  assert.equal(risk.blocked, true);
  assert.equal(risk.code, "credit_action_requires_handoff");
  assert.equal(risk.delegableCapability, CAPABILITIES.CREDITS_SUNO);
});

test("Studio Multitrack downloads use the finalize gate", () => {
  for (const name of ["Multitrack", "Multi-track"]) {
    const result = classifyAction({
      action: "click",
      node: { role: "menuitem", name },
      url: "https://suno.com/studio/song/abc",
    });
    assert.equal(result.code, "studio_download_requires_finalize");
    assert.equal(result.delegableCapability, CAPABILITIES.FINALIZE);
  }
});

test("Studio clip WAV download requires a real-user handoff", () => {
  const result = classifyAction({
    action: "click",
    node: { role: "button", name: "Download .WAV" },
    url: "https://suno.com/studio",
  });
  assert.equal(result.blocked, true);
  assert.equal(result.code, "studio_single_track_requires_handoff");
  assert.equal(result.delegableCapability, undefined);
});

test("Open in Studio multi-track creation is delegable via the credits capability", () => {
  const result = classifyAction({
    action: "click",
    node: {
      role: "button",
      name: "Multi-track Separate stems (50 credits)",
    },
    url: "https://suno.com/create",
  });
  assert.equal(result.blocked, true);
  assert.equal(result.code, "credit_action_requires_handoff");
  assert.equal(result.delegableCapability, CAPABILITIES.CREDITS_SUNO);
});

test("song-page formats never receive a Studio download permit", () => {
  for (const name of ["Download", "MP3", "WAV", "MP4 Video Asset", "Multitrack"]) {
    const result = classifyAction({
      action: "click",
      node: { role: "menuitem", name },
      url: "https://suno.com/song/example",
    });
    assert.notEqual(result.code, "studio_download_requires_finalize");
  }
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

test("never auto-checks human-verification controls", () => {
  for (const node of [
    { tag: "input", role: "checkbox", name: "I am human" },
    { tag: "button", role: "button", name: "I'm not a robot" },
    { tag: "div", role: "checkbox", name: "人机验证" },
  ]) {
    const risk = classifyAction({ action: "click", node, url: "https://suno.com/create" });
    assert.equal(risk.blocked, true, node.name);
    assert.equal(risk.code, "human_verification_requires_handoff");
  }
});

test("human-verification snapshot surfaces stop before an agent can click them", () => {
  const risk = classifySnapshotSurface({
    controls: [{ tag: "input", role: "checkbox", name: "I'm not a robot" }],
  });
  assert.equal(risk.blocked, true);
  assert.equal(risk.code, "human_verification_requires_handoff");
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

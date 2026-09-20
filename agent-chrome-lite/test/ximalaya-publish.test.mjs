import test from "node:test";
import assert from "node:assert/strict";

import {
  collectUploadFramesInTree,
  isXimalayaUploadFrame,
  isXimalayaUploadShell,
  locateXimalayaPublish,
  pointInFrame,
  uniquePublishButton,
} from "../src/browser/ximalaya-publish.mjs";
import { BrowserController } from "../src/browser/controller.mjs";

const button = {
  role: { value: "button" },
  name: { value: "确认发布" },
  backendDOMNodeId: 42,
};

test("Ximalaya entry permits only exact upload shell and upload iframe", () => {
  assert.equal(isXimalayaUploadShell("https://studio.ximalaya.com/upload"), true);
  assert.equal(isXimalayaUploadShell("https://studio.ximalaya.com/uploadWorks"), true);
  assert.equal(isXimalayaUploadShell("https://studio.ximalaya.com/upload/other"), false);
  assert.equal(isXimalayaUploadFrame("https://www.ximalaya.com/reform-upload/page/webCenter/upload"), true);
  assert.equal(isXimalayaUploadFrame("https://www.ximalaya.com/account"), false);
  assert.equal(isXimalayaUploadFrame("https://www.ximalaya.com.evil.test/reform-upload/page/upload"), false);
});

test("publish button must be exactly one enabled AX button", () => {
  assert.equal(uniquePublishButton([button]), 42);
  assert.throws(() => uniquePublishButton([button, button]), { code: "ximalaya_publish_target_unavailable" });
  assert.throws(() => uniquePublishButton([{ ...button, properties: [{
    name: "disabled", value: { value: true },
  }] }]), { code: "ximalaya_publish_target_unavailable" });
  assert.throws(() => uniquePublishButton([{ ...button, role: { value: "StaticText" } }]), {
    code: "ximalaya_publish_target_unavailable",
  });
});

test("frame geometry maps CSS viewport coordinates and rejects offscreen controls", () => {
  const frame = [100, 80, 900, 80, 900, 680, 100, 680];
  const buttonQuad = [600, 530, 720, 530, 720, 570, 600, 570];
  assert.deepEqual(pointInFrame(buttonQuad, frame, {
    clientWidth: 800, clientHeight: 600,
  }, { width: 1200, height: 800 }), { x: 760, y: 630 });
  assert.equal(pointInFrame(buttonQuad, frame, {
    clientWidth: 800, clientHeight: 500,
  }, { width: 1200, height: 800 }), null);
});

test("locate uses the iframe AX node, not a host-page text match or remembered coordinate", async () => {
  const calls = [];
  const cdp = {
    attachedFrames: async () => [{
      sessionId: "child-1", url: "https://www.ximalaya.com/reform-upload/page/webCenter/upload",
    }],
    send: async (method, params, options) => {
      calls.push([method, options?.sessionId]);
      switch (method) {
        case "Page.getFrameTree": return { frameTree: { frame: {
          id: "frame-1", url: "https://www.ximalaya.com/reform-upload/page/webCenter/upload",
        } } };
        case "DOM.enable":
        case "Accessibility.enable": return {};
        case "Accessibility.getFullAXTree": return { nodes: [button] };
        case "DOM.getFrameOwner": return { backendNodeId: 60 };
        case "DOM.getBoxModel": return { model: { width: 800, height: 600 } };
        case "DOM.getContentQuads": return { quads: [params.backendNodeId === 42
          ? [600, 530, 720, 530, 720, 570, 600, 570]
          : [100, 80, 900, 80, 900, 680, 100, 680]] };
        default: throw new Error(`Unexpected ${method}`);
      }
    },
  };
  const result = await locateXimalayaPublish(cdp,
    "https://studio.ximalaya.com/upload", { width: 1200, height: 800 });
  assert.deepEqual(result.point, { x: 760, y: 630 });
  assert.deepEqual(result.childPoint, { x: 660, y: 550 });
  assert.equal(result.sessionId, "child-1");
  assert.equal(result.node.name, "确认发布");
  assert.ok(calls.some(([method, sessionId]) =>
    method === "Accessibility.getFullAXTree" && sessionId === "child-1"));
  assert.ok(calls.some(([method, sessionId]) =>
    method === "DOM.getFrameOwner" && !sessionId));
});

test("final click is one-shot while the same upload form remains open", async () => {
  let dispatched = 0;
  const controller = {
    ximalayaPublishAttempted: false,
    inspectXimalayaPublish: async () => ({ sessionId: "frame", childPoint: { x: 12, y: 25 } }),
    clickPoint: async () => { dispatched += 1; },
  };
  await BrowserController.prototype.clickXimalayaPublish.call(controller);
  await assert.rejects(BrowserController.prototype.clickXimalayaPublish.call(controller), {
    code: "ximalaya_publish_attempt_unverified",
  });
  assert.equal(dispatched, 1);
});

test("in-process same-site iframe falls back to isolated world inspection", async () => {
  const frameUrl = "https://www.ximalaya.com/reform-upload/page/webCenter/upload";
  const cdp = {
    attachedFrames: async () => [],
    send: async (method, params) => {
      switch (method) {
        case "Page.getFrameTree": return { frameTree: {
          frame: { id: "top", url: "https://studio.ximalaya.com/upload" },
          childFrames: [{
            frame: { id: "frame-1", url: "about:blank" },
            childFrames: [{ frame: { id: "frame-2", url: frameUrl } }],
          }],
        } };
        case "Runtime.enable": return {};
        case "Page.createIsolatedWorld":
          assert.equal(params.frameId, "frame-2");
          return { executionContextId: 7 };
        case "Runtime.evaluate":
          assert.equal(params.contextId, 7);
          return { result: { value: { count: 1, x: 560, y: 450, width: 120, height: 40 } } };
        case "DOM.getFrameOwner": return { backendNodeId: 60 };
        case "DOM.getBoxModel": return { model: { width: 800, height: 600 } };
        case "DOM.getContentQuads": return { quads: [[100, 80, 900, 80, 900, 680, 100, 680]] };
        default: throw new Error(`Unexpected ${method}`);
      }
    },
  };
  const result = await locateXimalayaPublish(cdp,
    "https://studio.ximalaya.com/upload", { width: 1200, height: 800 });
  // button center (620, 470) in child → 100 + 620, 80 + 470 in top viewport
  assert.deepEqual(result.point, { x: 720, y: 550 });
  assert.deepEqual(result.childPoint, result.point);
  assert.equal(result.sessionId, undefined);
  assert.equal(result.node.name, "确认发布");
});

test("frame tree search collects upload iframes and reports what it saw", () => {
  const frameUrl = "https://www.ximalaya.com/reform-upload/page/webCenter/upload";
  assert.deepEqual(collectUploadFramesInTree({
    frame: { id: "top", url: "https://studio.ximalaya.com/upload" },
    childFrames: [{ frame: { id: "f1", url: frameUrl } }],
  }).matches.map((frame) => frame.id), ["f1"]);
  assert.equal(collectUploadFramesInTree({
    frame: { id: "top", url: "https://studio.ximalaya.com/upload" },
  }).matches.length, 0);
  assert.deepEqual(collectUploadFramesInTree({
    frame: { id: "top", url: "https://studio.ximalaya.com/upload" },
    childFrames: [
      { frame: { id: "f1", url: frameUrl } },
      { frame: { id: "f2", url: frameUrl } },
    ],
  }).matches.map((frame) => frame.id), ["f1", "f2"]);
});

test("duplicate upload iframes are disambiguated by probing for the visible button", async () => {
  const frameUrl = "https://www.ximalaya.com/reform-upload/page/webCenter/upload";
  const probed = [];
  const cdp = {
    attachedFrames: async () => [],
    send: async (method, params) => {
      switch (method) {
        case "Page.getFrameTree": return { frameTree: {
          frame: { id: "top", url: "https://studio.ximalaya.com/upload" },
          childFrames: [
            { frame: { id: "frame-hidden", url: frameUrl } },
            { frame: { id: "frame-live", url: frameUrl } },
          ],
        } };
        case "Runtime.enable": return {};
        case "Page.createIsolatedWorld":
          probed.push(params.frameId);
          return { executionContextId: params.frameId === "frame-hidden" ? 7 : 8 };
        case "Runtime.evaluate":
          if (params.contextId === 7) return { result: { value: { count: 0 } } };
          return { result: { value: { count: 1, x: 560, y: 450, width: 120, height: 40 } } };
        case "DOM.getFrameOwner":
          assert.equal(params.frameId, "frame-live");
          return { backendNodeId: 60 };
        case "DOM.getBoxModel": return { model: { width: 800, height: 600 } };
        case "DOM.getContentQuads": return { quads: [[100, 80, 900, 80, 900, 680, 100, 680]] };
        default: throw new Error(`Unexpected ${method}`);
      }
    },
  };
  const result = await locateXimalayaPublish(cdp,
    "https://studio.ximalaya.com/upload", { width: 1200, height: 800 });
  assert.deepEqual(probed, ["frame-hidden", "frame-live"]);
  assert.deepEqual(result.point, { x: 720, y: 550 });
  assert.equal(result.node.name, "确认发布");
});

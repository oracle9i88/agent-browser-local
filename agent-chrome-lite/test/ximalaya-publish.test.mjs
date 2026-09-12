import test from "node:test";
import assert from "node:assert/strict";

import {
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

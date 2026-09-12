import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { CdpSession } from "../src/browser/cdp-session.mjs";

test("a hung CDP command times out and reports a recoverable page fault", async () => {
  const faults = [];
  const webContents = {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => true,
      sendCommand: () => new Promise(() => undefined),
    },
  };
  const cdp = new CdpSession(webContents, {
    commandTimeoutMs: 5,
    onFault: (error) => faults.push(error),
  });

  await assert.rejects(
    cdp.send("Accessibility.getFullAXTree"),
    (error) =>
      error.code === "cdp_command_timeout" &&
      error.detail.method === "Accessibility.getFullAXTree",
  );
  assert.equal(faults.length, 1);
  assert.equal(faults[0].code, "cdp_command_timeout");
});

test("flat child-target CDP commands use the frame session and discard detached targets", async () => {
  const debuggerEvents = new EventEmitter();
  const commands = [];
  let firstAttach = true;
  Object.assign(debuggerEvents, {
    isAttached: () => true,
    detach: () => undefined,
    sendCommand: async (method, params, sessionId) => {
      commands.push({ method, sessionId });
      if (method === "Target.setAutoAttach" && firstAttach) {
        firstAttach = false;
        debuggerEvents.emit("message", {}, "Target.attachedToTarget", {
          sessionId: "frame-session",
          targetInfo: { targetId: "frame-target", type: "iframe", url: "https://www.ximalaya.com/reform-upload/page/upload" },
        });
      }
      return {};
    },
  });
  const cdp = new CdpSession({ isDestroyed: () => false, debugger: debuggerEvents });
  assert.deepEqual(await cdp.attachedFrames(), [{
    sessionId: "frame-session", url: "https://www.ximalaya.com/reform-upload/page/upload",
  }]);
  await cdp.send("Accessibility.getFullAXTree", {}, { sessionId: "frame-session" });
  assert.deepEqual(commands.at(-1), {
    method: "Accessibility.getFullAXTree", sessionId: "frame-session",
  });
  debuggerEvents.emit("message", {}, "Target.detachedFromTarget", { sessionId: "frame-session" });
  assert.deepEqual(await cdp.attachedFrames(), []);
  cdp.detach();
});

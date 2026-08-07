import test from "node:test";
import assert from "node:assert/strict";

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

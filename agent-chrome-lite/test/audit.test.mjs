import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AuditLog } from "../src/audit.mjs";

test("persisted fill audit stores value length and hash but not raw content", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "abl-audit-test-"));
  try {
    const file = path.join(directory, "events.jsonl");
    const secret = "第一段：不应进入审计的正文";
    await new AuditLog(file).record({
      event: "browser.fill",
      field: "textbox",
      value: secret,
    });
    const persisted = await readFile(file, "utf8");
    assert.equal(persisted.includes(secret), false);
    const event = JSON.parse(persisted);
    assert.equal(event.value, undefined);
    assert.equal(event.valueLength, secret.length);
    assert.match(event.valueSha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

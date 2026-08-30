import test from "node:test";
import assert from "node:assert/strict";

import { updateFinalizeCapability } from "../scripts/agent-permissions.mjs";
import { CAPABILITIES } from "../src/constants.mjs";

function config() {
  return {
    agents: [
      { principal: "codex", capabilities: [CAPABILITIES.SNAPSHOT] },
      { principal: "claude", capabilities: [CAPABILITIES.SNAPSHOT] },
    ],
  };
}

test("local permission manager grants finalize to only one named principal", () => {
  const value = updateFinalizeCapability(config(), "codex", true);
  assert.equal(value.agents[0].capabilities.includes(CAPABILITIES.FINALIZE), true);
  assert.equal(value.agents[1].capabilities.includes(CAPABILITIES.FINALIZE), false);
});

test("local permission manager revokes finalize idempotently", () => {
  const value = config();
  updateFinalizeCapability(value, "codex", true);
  updateFinalizeCapability(value, "codex", true);
  updateFinalizeCapability(value, "codex", false);
  assert.equal(value.agents[0].capabilities.includes(CAPABILITIES.FINALIZE), false);
});

test("local permission manager rejects unknown principals", () => {
  assert.throws(
    () => updateFinalizeCapability(config(), "intruder", true),
    /Unknown locally configured principal/,
  );
});

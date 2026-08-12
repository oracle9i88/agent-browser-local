import test from "node:test";
import assert from "node:assert/strict";

import { authenticateToken, hashToken } from "../src/config.mjs";
import { CONFIRMATION_POLICY } from "../src/constants.mjs";

test("principal and capabilities come from local token mapping", () => {
  const token = "abl_this_is_a_long_local_test_token_123456789";
  const config = {
    agents: [
      {
        principal: "codex",
        tokenSha256: hashToken(token),
        capabilities: ["browser.snapshot"],
        confirmationPolicy: CONFIRMATION_POLICY,
      },
    ],
  };

  const identity = authenticateToken(config, token);
  assert.deepEqual(identity, {
    principal: "codex",
    capabilities: ["browser.snapshot"],
    confirmationPolicy: CONFIRMATION_POLICY,
  });
  assert.equal(authenticateToken(config, "abl_wrong_but_long_enough_token_000000000"), null);
});


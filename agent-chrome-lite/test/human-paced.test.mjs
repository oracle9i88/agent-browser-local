import test from "node:test";
import assert from "node:assert/strict";

import { HumanPacedExecutor } from "../src/executor/human-paced.mjs";

test("serializes actions and applies a gap after the first action", async () => {
  let now = 0;
  const waits = [];
  const order = [];
  const executor = new HumanPacedExecutor({
    minDelayMs: 100,
    maxDelayMs: 100,
    random: () => 0,
    now: () => now,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });

  const first = executor.run(async () => {
    order.push("first");
    now += 5;
  });
  const second = executor.run(async () => {
    order.push("second");
    now += 5;
  });
  await Promise.all([first, second]);

  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(waits, [100]);
});


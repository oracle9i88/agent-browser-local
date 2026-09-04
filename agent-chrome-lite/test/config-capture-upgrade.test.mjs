import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createConfig, loadConfig } from "../src/config.mjs";
import { CAPABILITIES } from "../src/constants.mjs";

test("loading a v2 config adds new capture/download capabilities to existing principals", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "abl-config-capture-"));
  try {
    const configPath = path.join(directory, "config.json");
    const created = await createConfig(configPath);

    // 模拟老 v2（beta.12 及更早）配置：principal 上没有 capture/download 两项
    const downgraded = JSON.parse(JSON.stringify(created.config));
    downgraded.version = 2;
    for (const agent of downgraded.agents) {
      agent.capabilities = agent.capabilities.filter(
        (capability) =>
          capability !== CAPABILITIES.CAPTURE_SERIES &&
          capability !== CAPABILITIES.DOWNLOAD_STATUS,
      );
    }
    await writeFile(configPath, `${JSON.stringify(downgraded, null, 2)}\n`, {
      mode: 0o600,
    });

    const { config } = await loadConfig(configPath);
    assert.equal(config.version, 2);
    for (const agent of config.agents) {
      assert.equal(
        agent.capabilities.includes(CAPABILITIES.CAPTURE_SERIES),
        true,
        `agent ${agent.principal} should have ${CAPABILITIES.CAPTURE_SERIES}`,
      );
      assert.equal(
        agent.capabilities.includes(CAPABILITIES.DOWNLOAD_STATUS),
        true,
        `agent ${agent.principal} should have ${CAPABILITIES.DOWNLOAD_STATUS}`,
      );
    }

    // 重新读盘确认真的写回去了（不是只在内存里）
    const onDisk = JSON.parse(await readFile(configPath, "utf8"));
    for (const agent of onDisk.agents) {
      assert.equal(
        agent.capabilities.includes(CAPABILITIES.CAPTURE_SERIES),
        true,
      );
      assert.equal(
        agent.capabilities.includes(CAPABILITIES.DOWNLOAD_STATUS),
        true,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

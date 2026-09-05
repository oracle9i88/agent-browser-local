import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createConfig, loadConfig } from "../src/config.mjs";
import { CAPABILITIES } from "../src/constants.mjs";

test("loading a beta.13 v2 config revokes automatically granted Suno capabilities", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "abl-config-capture-"));
  try {
    const configPath = path.join(directory, "config.json");
    const created = await createConfig(configPath);

    // 模拟 beta.13 v2：两个高范围能力曾被自动授予所有 principal。
    const downgraded = JSON.parse(JSON.stringify(created.config));
    downgraded.version = 2;
    for (const agent of downgraded.agents) {
      agent.capabilities.push(
        CAPABILITIES.CAPTURE_SERIES,
        CAPABILITIES.DOWNLOAD_STATUS,
      );
    }
    await writeFile(configPath, `${JSON.stringify(downgraded, null, 2)}\n`, {
      mode: 0o600,
    });

    const { config } = await loadConfig(configPath);
    assert.equal(config.version, 3);
    for (const agent of config.agents) {
      assert.equal(
        agent.capabilities.includes(CAPABILITIES.CAPTURE_SERIES),
        false,
        `agent ${agent.principal} should not retain ${CAPABILITIES.CAPTURE_SERIES}`,
      );
      assert.equal(
        agent.capabilities.includes(CAPABILITIES.DOWNLOAD_STATUS),
        false,
        `agent ${agent.principal} should not retain ${CAPABILITIES.DOWNLOAD_STATUS}`,
      );
    }

    // 重新读盘确认真的写回去了（不是只在内存里）
    const onDisk = JSON.parse(await readFile(configPath, "utf8"));
    for (const agent of onDisk.agents) {
      assert.equal(
        agent.capabilities.includes(CAPABILITIES.CAPTURE_SERIES),
        false,
      );
      assert.equal(agent.capabilities.includes(CAPABILITIES.DOWNLOAD_STATUS), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createConfig, loadConfig } from "../src/config.mjs";
import { contributionTargetsFor } from "../src/security/platform-registry.mjs";

test("loading a legacy config atomically tightens Xiaoyuzhou without rotating tokens", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "abl-config-upgrade-"));
  try {
    const configPath = path.join(directory, "config.json");
    const created = await createConfig(configPath);
    const tokenHashes = created.config.agents.map((agent) => agent.tokenSha256);
    created.config.security.contributionTargets = created.config.security.contributionTargets.map(
      (target) =>
        target.origin === "https://podcaster.xiaoyuzhoufm.com"
          ? {
              platform: "xiaoyuzhou",
              origin: target.origin,
              pathPrefixes: ["/"],
            }
          : target,
    );
    await writeFile(configPath, `${JSON.stringify(created.config, null, 2)}\n`, {
      mode: 0o600,
    });

    const { config } = await loadConfig(configPath);
    assert.deepEqual(
      config.security.contributionTargets.filter(
        (target) => target.origin === "https://podcaster.xiaoyuzhoufm.com",
      ),
      contributionTargetsFor(["xiaoyuzhou"]),
    );
    assert.deepEqual(
      config.agents.map((agent) => agent.tokenSha256),
      tokenHashes,
    );

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(persisted.security.contributionTargets, config.security.contributionTargets);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

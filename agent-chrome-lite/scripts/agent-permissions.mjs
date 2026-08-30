#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { defaultConfigPath } from "../src/config.mjs";
import { CAPABILITIES } from "../src/constants.mjs";

function usage() {
  return [
    "Usage:",
    "  npm run agent-permissions -- --list",
    "  npm run agent-permissions -- --grant-finalize <principal>",
    "  npm run agent-permissions -- --revoke-finalize <principal>",
  ].join("\n");
}

export function updateFinalizeCapability(config, principal, enabled) {
  const agent = config?.agents?.find((entry) => entry.principal === principal);
  if (!agent) throw new Error(`Unknown locally configured principal: ${principal}`);
  if (!Array.isArray(agent.capabilities)) {
    throw new Error(`Missing capabilities for ${principal}`);
  }

  const current = new Set(agent.capabilities);
  if (enabled) current.add(CAPABILITIES.FINALIZE);
  else current.delete(CAPABILITIES.FINALIZE);
  agent.capabilities = [...current];
  return config;
}

async function main() {
  const [command, principal, ...extra] = process.argv.slice(2);
  if (extra.length || !command) throw new Error(usage());

  const configPath = defaultConfigPath();
  const config = JSON.parse(await readFile(configPath, "utf8"));

  if (command === "--list" && !principal) {
    for (const agent of config.agents || []) {
      const enabled = agent.capabilities?.includes(CAPABILITIES.FINALIZE);
      process.stdout.write(`${agent.principal}\tfinalize=${enabled ? "on" : "off"}\n`);
    }
    return;
  }

  const enabled = command === "--grant-finalize";
  if ((!enabled && command !== "--revoke-finalize") || !principal) {
    throw new Error(usage());
  }

  updateFinalizeCapability(config, principal, enabled);
  const tempPath = `${configPath}.${process.pid}.permissions.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, configPath);
  process.stdout.write(
    `${principal}\tfinalize=${enabled ? "on" : "off"}\nRestart Agent Browser Local to apply.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

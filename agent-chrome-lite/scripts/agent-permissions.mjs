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
    "  npm run agent-permissions -- --grant-suno-studio <principal>",
    "  npm run agent-permissions -- --revoke-suno-studio <principal>",
    "  npm run agent-permissions -- --grant-suno-credits <principal>",
    "  npm run agent-permissions -- --revoke-suno-credits <principal>",
  ].join("\n");
}

export function updateFinalizeCapability(config, principal, enabled) {
  return updateCapabilities(config, principal, [CAPABILITIES.FINALIZE], enabled);
}

export function updateSunoCreditsCapability(config, principal, enabled) {
  return updateCapabilities(config, principal, [CAPABILITIES.CREDITS_SUNO], enabled);
}

export function updateSunoStudioCapabilities(config, principal, enabled) {
  return updateCapabilities(
    config,
    principal,
    [CAPABILITIES.CAPTURE_SERIES, CAPABILITIES.DOWNLOAD_STATUS],
    enabled,
  );
}

function updateCapabilities(config, principal, capabilities, enabled) {
  const agent = config?.agents?.find((entry) => entry.principal === principal);
  if (!agent) throw new Error(`Unknown locally configured principal: ${principal}`);
  if (!Array.isArray(agent.capabilities)) {
    throw new Error(`Missing capabilities for ${principal}`);
  }

  const current = new Set(agent.capabilities);
  for (const capability of capabilities) {
    if (enabled) current.add(capability);
    else current.delete(capability);
  }
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
      const finalize = agent.capabilities?.includes(CAPABILITIES.FINALIZE);
      const sunoStudio =
        agent.capabilities?.includes(CAPABILITIES.CAPTURE_SERIES) &&
        agent.capabilities?.includes(CAPABILITIES.DOWNLOAD_STATUS);
      const sunoCredits = agent.capabilities?.includes(CAPABILITIES.CREDITS_SUNO);
      process.stdout.write(
        `${agent.principal}\tfinalize=${finalize ? "on" : "off"}` +
        `\tsuno-studio=${sunoStudio ? "on" : "off"}` +
        `\tsuno-credits=${sunoCredits ? "on" : "off"}\n`,
      );
    }
    return;
  }

  const actions = new Map([
    ["--grant-finalize", { kind: "finalize", enabled: true }],
    ["--revoke-finalize", { kind: "finalize", enabled: false }],
    ["--grant-suno-studio", { kind: "suno-studio", enabled: true }],
    ["--revoke-suno-studio", { kind: "suno-studio", enabled: false }],
    ["--grant-suno-credits", { kind: "suno-credits", enabled: true }],
    ["--revoke-suno-credits", { kind: "suno-credits", enabled: false }],
  ]);
  const action = actions.get(command);
  if (!action || !principal) {
    throw new Error(usage());
  }

  if (action.kind === "finalize") {
    updateFinalizeCapability(config, principal, action.enabled);
  } else if (action.kind === "suno-credits") {
    updateSunoCreditsCapability(config, principal, action.enabled);
  } else {
    updateSunoStudioCapabilities(config, principal, action.enabled);
  }
  const tempPath = `${configPath}.${process.pid}.permissions.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, configPath);
  process.stdout.write(
    `${principal}\t${action.kind}=${action.enabled ? "on" : "off"}` +
      "\nRestart Agent Browser Local to apply.\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

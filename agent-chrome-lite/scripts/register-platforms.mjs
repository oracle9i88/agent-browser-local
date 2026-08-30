#!/usr/bin/env node

import { rename, writeFile } from "node:fs/promises";

import { defaultConfigPath, loadConfig } from "../src/config.mjs";
import {
  DEFAULT_PLATFORM_IDS,
  mergeContributionTargets,
  PLATFORM_REGISTRY,
  removeContributionTargets,
} from "../src/security/platform-registry.mjs";

const args = process.argv.slice(2);
const disable = args[0] === "--disable";
const requested = disable ? args.slice(1) : args;

if (requested.includes("--list")) {
  for (const platformId of DEFAULT_PLATFORM_IDS) {
    console.log(`${platformId}\t${PLATFORM_REGISTRY[platformId].label}`);
  }
  process.exit(0);
}

if (requested.length === 0) {
  console.error(
    "Usage: node scripts/register-platforms.mjs [--disable] <platform-id> [...]",
  );
  process.exit(2);
}

const configPath = defaultConfigPath();
const { config } = await loadConfig(configPath);
const before = JSON.stringify(config.security.contributionTargets);
config.security.contributionTargets = disable
  ? removeContributionTargets(config.security.contributionTargets, requested)
  : mergeContributionTargets(config.security.contributionTargets, requested);
const after = JSON.stringify(config.security.contributionTargets);

if (before === after) {
  console.log(`No changes needed: ${disable ? "disabled " : ""}${requested.join(", ")}`);
  process.exit(0);
}

const tempPath = `${configPath}.${process.pid}.tmp`;
await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
await rename(tempPath, configPath);
console.log(
  `${disable ? "Disabled" : "Registered"} in ${configPath}: ${requested.join(", ")}`,
);

#!/usr/bin/env node

import { defaultRuntimeDir, storeTokens } from "../src/config.mjs";

const principals = ["codex", "claude", "novage", "novade"];
const tokens = Object.fromEntries(
  principals.map((principal) => {
    const name = `ABL_${principal.toUpperCase()}_TOKEN`;
    const token = process.env[name];
    if (!token) throw new Error(`${name} is required`);
    return [principal, token];
  }),
);

const tokenPath = await storeTokens(defaultRuntimeDir(), tokens);
console.log(`Saved ${tokenPath} with mode 0600`);


#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const roots = ["src", "mcp", "scripts", "test", "bin"];
const files = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) files.push(full);
  }
}

for (const root of roots) await walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax OK: ${files.length} files`);


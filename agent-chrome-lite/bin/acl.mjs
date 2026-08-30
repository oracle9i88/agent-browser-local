#!/usr/bin/env node

import { spawn } from "node:child_process";
import electronPath from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(electronPath, [path.join(projectDir, "src", "main.mjs")], {
  cwd: projectDir,
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});


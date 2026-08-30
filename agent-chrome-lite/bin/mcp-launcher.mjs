import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KNOWN_PRINCIPALS = new Set(["codex", "claude"]);

function tokenFromEnvFile(contents, principal) {
  const key = `ABL_${principal.toUpperCase()}_TOKEN`;
  for (const line of contents.split(/\r?\n/)) {
    const [name, ...valueParts] = line.split("=");
    if (name === key && valueParts.length) return valueParts.join("=");
  }
  return "";
}

export async function launchMcp(principal) {
  if (!KNOWN_PRINCIPALS.has(principal)) {
    throw new Error("This fixed MCP launcher does not recognize the principal");
  }
  const runtimeDir =
    process.env.ABL_RUNTIME_DIR || path.join(os.homedir(), ".agent-browser-local");
  const tokenFile = path.join(runtimeDir, "tokens.env");
  const token = tokenFromEnvFile(await readFile(tokenFile, "utf8"), principal);
  if (!token) throw new Error(`Missing fixed ${principal} token in ${tokenFile}`);
  process.env.ABL_TOKEN = token;
  await import("../mcp/server.mjs");
}

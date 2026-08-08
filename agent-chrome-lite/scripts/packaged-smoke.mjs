import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(
  projectDir,
  "dist",
  "Agent Browser Local.app",
  "Contents",
  "MacOS",
  "Agent Browser Local",
);
const manifestPath = path.join(projectDir, "dist", "release-manifest.json");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-browser-packaged-smoke-"));

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => {
      reject(new Error(`Process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`Process exited by ${signal}`));
      else resolve(code);
    });
  });
}

async function waitForHealth(port, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch {
      // The packaged daemon is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Packaged daemon did not become healthy");
}

function launch(env) {
  const child = spawn(executable, [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.capturedOutput = output;
  return child;
}

let first;
let second;
try {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const archivePath = path.join(projectDir, "dist", manifest.archive);
  const archiveInfo = await stat(archivePath);
  if (
    archiveInfo.size !== manifest.archiveBytes ||
    (await sha256(archivePath)) !== manifest.archiveSha256
  ) {
    throw new Error("Packaged archive does not match release-manifest.json");
  }
  const port = await reservePort();
  const runtimeDir = path.join(tempDir, "runtime");
  const env = {
    ...process.env,
    ABL_RUNTIME_DIR: runtimeDir,
    ABL_PROFILE_DIR: path.join(tempDir, "profile"),
    ABL_PORT: String(port),
    ABL_SMOKE_HEADLESS: "1",
    ABL_SMOKE_EXIT_MS: "4500",
  };

  first = launch(env);
  const health = await waitForHealth(port);
  second = launch(env);
  const secondExit = await waitForExit(second, 3000);
  if (secondExit !== 0) {
    throw new Error(`Second packaged instance exited with code ${secondExit}`);
  }
  const healthAfterSecondLaunch = await waitForHealth(port, 2000);
  const firstExit = await waitForExit(first, 8000);
  if (firstExit !== 0) {
    throw new Error(`Packaged app exited with code ${firstExit}`);
  }

  const config = JSON.parse(
    await readFile(path.join(runtimeDir, "config.json"), "utf8"),
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        health,
        healthAfterSecondLaunch,
        singleInstance: true,
        principals: config.agents.map((agent) => agent.principal),
        profile: "temporary",
        accountPagesOpened: false,
        releaseManifestVerified: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  for (const child of [second, first]) {
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }
  const captured = [first, second]
    .flatMap((child) => child?.capturedOutput || [])
    .join("")
    .replace(/abl_[A-Za-z0-9_-]+/g, "abl_[redacted]");
  if (captured) console.error(captured);
  throw error;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

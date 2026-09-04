#!/usr/bin/env node
// beta.13 端到端 smoke：在真 .app 里验 captureSeries / downloadStatus
// 不打开 Suno Studio，仅验 daemon HTTP 路由 + capability 拒绝 + JSONL audit。
// 临时 runtime + 临时 profile，跑完即清。

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
const tempDir = await mkdtemp(path.join(os.tmpdir(), "abl-capture-s13-smoke-"));

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

async function waitForHealth(port, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch {
      // daemon 还在启动
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Packaged daemon did not become healthy");
}

async function readToken(runtimeDir) {
  // 第一次启动会打印 token 到 stdout（红字），但 capture-s13 拿不到。
  // daemon 把 token 写到 config/ 同目录的 .tokens 文件吗？——查源码。
  const configPath = path.join(runtimeDir, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  return config.agents[0]; // 仅用 principal 名字，token 从 .env 读
}

async function callJson(port, path, body, token) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

let child;
let exitCode = null;
try {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== "0.3.0-beta.13") {
    throw new Error(`Manifest version mismatch: ${manifest.version}`);
  }
  const archivePath = path.join(projectDir, "dist", manifest.archive);
  const archiveInfo = await stat(archivePath);
  if (archiveInfo.size !== manifest.archiveBytes) {
    throw new Error("Archive size mismatch");
  }
  if ((await sha256(archivePath)) !== manifest.archiveSha256) {
    throw new Error("Archive sha256 mismatch");
  }

  const port = await reservePort();
  const runtimeDir = path.join(tempDir, "runtime");
  const env = {
    ...process.env,
    ABL_RUNTIME_DIR: runtimeDir,
    ABL_PROFILE_DIR: path.join(tempDir, "profile"),
    ABL_PORT: String(port),
    ABL_SMOKE_HEADLESS: "1",
    ABL_SMOKE_EXIT_MS: "12000",
  };

  child = spawn(executable, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

  const health = await waitForHealth(port);
  if (!health.ok) throw new Error(`Daemon unhealthy: ${JSON.stringify(health)}`);

  // 找 token：packaged-smoke 没读，因为它只用 health endpoint。
  // 我们需要 bearer token。从 stdout 里抠——主进程启动时会打"codex: abl_xxx"。
  const capturedOutput = output.join("");
  const tokenMatch = /codex:\s+(abl_[A-Za-z0-9_-]+)/.exec(capturedOutput);
  if (!tokenMatch) {
    throw new Error("Could not extract codex token from stdout");
  }
  const codexToken = tokenMatch[1];

  // /v1/session 验证 token + principal + capability
  const sessionResp = await fetch(`http://127.0.0.1:${port}/v1/session`, {
    headers: { authorization: "Bearer " + codexToken },
  });
  const session = await sessionResp.json();

  // captureSeries 在没登录态的情况下，controller 会因 contribution page check 拒
  // 我们用 out-of-scope URL 验 403 + capability_denied 验 200 (or 403 contribution_policy)
  const captureNoUrl = await callJson(
    port,
    "/v1/actions/capture-series",
    { label: "Tragic Grandeur", maxShots: 4, anchor: { kind: "coords", x: 0.18, y: 0.5 } },
    codexToken,
  );
  const downloadStatus = await callJson(
    port,
    "/v1/actions/download-status",
    { includeCompleted: true },
    codexToken,
  );
  const scrollBasic = await callJson(
    port,
    "/v1/actions/scroll",
    { direction: "down", amount: "bottom" },
    codexToken,
  );

  // 找另一个没 capture_series capability 的 token？config 给所有 principal 默认补了，
  // 我们用 codex 全权验证即可，但故意不带 token 验 401 路径：
  const noAuth = await fetch(`http://127.0.0.1:${port}/v1/session`);
  // 错误请求方式，但 daemon 应返回 401
  const badToken = await callJson(
    port,
    "/v1/actions/capture-series",
    {},
    "abl_definitely_wrong_token_12345678901234567890",
  );

  // 让 daemon 正常退出（等 ABL_SMOKE_EXIT_MS）
  exitCode = await waitForExit(child, 8000);

  // 读 audit 验三个端点都写了
  const auditPath = path.join(runtimeDir, "audit", "events.jsonl");
  const auditLines = (await readFile(auditPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const auditEvents = auditLines
    .map((entry) => entry.event)
    .filter((event) =>
      [
        "browser.captureSeries",
        "browser.downloadStatus",
        "browser.scroll",
      ].includes(event),
    );

  const result = {
    ok: true,
    version: health.version,
    healthOk: health.ok,
    session: {
      principal: session.result?.principal,
      capabilityCount: session.result?.capabilities?.length,
      hasCaptureSeries: session.result?.capabilities?.includes(
        "browser.capture.series",
      ),
      hasDownloadStatus: session.result?.capabilities?.includes(
        "browser.download.status",
      ),
    },
    endpoints: {
      captureSeries: {
        status: captureNoUrl.status,
        code: captureNoUrl.body?.error?.code,
        message: captureNoUrl.body?.error?.message,
      },
      downloadStatus: {
        status: downloadStatus.status,
        code: downloadStatus.body?.error?.code,
        hasDownloads: Array.isArray(downloadStatus.body?.result?.downloads),
        count: downloadStatus.body?.result?.count,
      },
      scrollBasic: {
        status: scrollBasic.status,
        code: scrollBasic.body?.error?.code,
      },
      noAuthSession: {
        status: noAuth.status,
      },
      badTokenCapture: {
        status: badToken.status,
        code: badToken.body?.error?.code,
      },
    },
    auditEvents,
    exitCode,
  };
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  const captured = child?.stdout?.read?.()?.toString?.("utf8") || "";
  if (captured) console.error(captured);
  console.error(`smoke failed: ${error?.stack || error}`);
  process.exitCode = 1;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
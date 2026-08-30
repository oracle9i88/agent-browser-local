import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultConfigPath, defaultRuntimeDir } from "../src/config.mjs";
import { PRODUCT_NAME, VERSION } from "../src/constants.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = defaultRuntimeDir();
const configPath = defaultConfigPath();
const tokenPath = path.join(runtimeDir, "tokens.env");
const profilePath = process.env.ABL_PROFILE_DIR || path.join(runtimeDir, "profile");
const manifestPath = path.join(projectDir, "dist", "release-manifest.json");
const appPath = path.join(projectDir, "dist", "Agent Browser Local.app");

async function fileState(filePath, { directory = false } = {}) {
  try {
    const info = await stat(filePath);
    return {
      exists: true,
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      expectedType: directory ? info.isDirectory() : info.isFile(),
      mode: (info.mode & 0o777).toString(8).padStart(3, "0"),
      size: info.isFile() ? info.size : undefined,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function daemonState(config) {
  if (config?.server?.host !== "127.0.0.1") {
    return { running: false, safeBinding: false, reason: "unsafe_configured_host" };
  }
  const port = Number(config.server.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { running: false, safeBinding: true, reason: "invalid_port" };
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    const body = await response.json();
    return {
      running:
        response.ok &&
        body.product === PRODUCT_NAME &&
        body.binding === "loopback-only",
      safeBinding: body.binding === "loopback-only",
      version: body.version,
    };
  } catch {
    return { running: false, safeBinding: true, reason: "not_listening" };
  }
}

async function packageState() {
  const app = await fileState(appPath, { directory: true });
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { app, manifest: { exists: false }, verified: false };
    }
    throw error;
  }
  const archivePath = path.join(projectDir, "dist", path.basename(manifest.archive));
  const archive = await fileState(archivePath);
  const verified =
    app.exists &&
    app.expectedType &&
    archive.exists &&
    archive.expectedType &&
    archive.size === manifest.archiveBytes &&
    (await sha256(archivePath)) === manifest.archiveSha256;
  return {
    app,
    archive: {
      exists: archive.exists,
      size: archive.size,
      name: path.basename(archivePath),
    },
    manifest: {
      exists: true,
      version: manifest.version,
      signing: manifest.signing,
      notarized: manifest.notarized,
    },
    verified,
  };
}

const configFile = await fileState(configPath);
const tokenFile = await fileState(tokenPath);
const profile = await fileState(profilePath, { directory: true });
let config = null;
let configError = null;
if (configFile.exists) {
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    configError = String(error.message || error).slice(0, 500);
  }
}

const report = {
  product: PRODUCT_NAME,
  sourceVersion: VERSION,
  runtime: {
    initialized: Boolean(config && tokenFile.exists),
    config: {
      exists: configFile.exists,
      mode: configFile.mode,
      secureMode: !configFile.exists || configFile.mode === "600",
      validJson: Boolean(config),
      error: configError,
    },
    tokens: {
      exists: tokenFile.exists,
      mode: tokenFile.mode,
      secureMode: !tokenFile.exists || tokenFile.mode === "600",
      contentsRead: false,
    },
    profile: {
      exists: profile.exists,
      expectedType: profile.expectedType,
    },
    principals: Array.isArray(config?.agents)
      ? config.agents.map((agent) => agent.principal)
      : [],
  },
  daemon: config
    ? await daemonState(config)
    : { running: false, safeBinding: true, reason: "not_initialized" },
  package: await packageState(),
};

report.ok = Boolean(
  report.runtime.config.secureMode &&
    report.runtime.tokens.secureMode &&
    !report.runtime.config.error &&
    report.daemon.safeBinding &&
    report.package.verified,
);

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CONFIRMATION_POLICY,
  DEFAULT_CAPABILITIES,
} from "./constants.mjs";
import {
  contributionTargetsFor,
  hardenLegacyContributionTargets,
} from "./security/platform-registry.mjs";

const CONFIG_VERSION = 1;
const DEFAULT_PRINCIPALS = ["codex", "claude", "novage", "novade"];

function makeToken() {
  return `abl_${randomBytes(32).toString("base64url")}`;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function defaultUploadRoots() {
  return ["Desktop", "Documents", "Downloads"].map((name) =>
    path.join(os.homedir(), name),
  );
}

export function defaultRuntimeDir() {
  return (
    process.env.ABL_RUNTIME_DIR ||
    path.join(os.homedir(), ".agent-browser-local")
  );
}

export function defaultConfigPath() {
  return (
    process.env.ABL_CONFIG_PATH ||
    path.join(defaultRuntimeDir(), "config.json")
  );
}

export async function createConfig(configPath = defaultConfigPath()) {
  const runtimeDir = path.dirname(configPath);
  await mkdir(runtimeDir, { recursive: true });

  const tokens = Object.fromEntries(
    DEFAULT_PRINCIPALS.map((principal) => [principal, makeToken()]),
  );
  const config = {
    version: CONFIG_VERSION,
    server: {
      host: "127.0.0.1",
      port: Number(process.env.ABL_PORT || 3767),
    },
    browser: {
      profileDir: path.join(runtimeDir, "profile"),
      startUrl: "about:blank",
    },
    security: {
      uploadRoots: defaultUploadRoots(),
      contributionTargets: contributionTargetsFor(),
      minActionDelayMs: 850,
      maxActionDelayMs: 1650,
      maxSnapshotControls: 180,
      maxSnapshotHints: 80,
    },
    agents: DEFAULT_PRINCIPALS.map((principal) => ({
      principal,
      tokenSha256: hashToken(tokens[principal]),
      capabilities: [...DEFAULT_CAPABILITIES],
      confirmationPolicy: CONFIRMATION_POLICY,
    })),
  };

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });

  const tokenPath = await storeTokens(runtimeDir, tokens);

  return { config, configPath, tokenPath, tokens };
}

export async function storeTokens(runtimeDir, tokens) {
  const tokenPath = path.join(runtimeDir, "tokens.env");
  const contents = Object.entries(tokens)
    .map(([principal, token]) => `ABL_${principal.toUpperCase()}_TOKEN=${token}`)
    .join("\n");
  await writeFile(tokenPath, `${contents}\n`, { mode: 0o600, flag: "wx" });
  return tokenPath;
}

export async function loadConfig(configPath = defaultConfigPath()) {
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return createConfig(configPath);
  }

  const config = JSON.parse(raw);
  const beforeTargets = JSON.stringify(config.security?.contributionTargets || []);
  if (config.security?.contributionTargets) {
    config.security.contributionTargets = hardenLegacyContributionTargets(
      config.security.contributionTargets,
    );
  }
  validateConfig(config);
  if (JSON.stringify(config.security.contributionTargets) !== beforeTargets) {
    const tempPath = `${configPath}.${process.pid}.security-upgrade.tmp`;
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, configPath);
  }
  return { config, configPath, tokenPath: null, tokens: null };
}

function validateConfig(config) {
  if (config?.version !== CONFIG_VERSION) {
    throw new Error(`Unsupported config version: ${config?.version}`);
  }
  if (config?.server?.host !== "127.0.0.1") {
    throw new Error("The daemon must listen on 127.0.0.1");
  }
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error("At least one locally configured principal is required");
  }
  if (!Array.isArray(config.security?.contributionTargets)) {
    throw new Error("security.contributionTargets must be a local allowlist");
  }
  for (const target of config.security.contributionTargets) {
    let origin;
    try {
      origin = new URL(target.origin).origin;
    } catch {
      throw new Error("Invalid contribution target origin");
    }
    const hasPrefixes = Array.isArray(target.pathPrefixes);
    const hasTemplates = Array.isArray(target.pathTemplates);
    if (origin !== target.origin || (!hasPrefixes && !hasTemplates)) {
      throw new Error("Invalid contribution target");
    }
    if (
      (hasPrefixes && target.pathPrefixes.some(
        (prefix) => typeof prefix !== "string" || !prefix.startsWith("/"),
      )) ||
      (hasTemplates && target.pathTemplates.some(
        (template) =>
          typeof template !== "string" ||
          !template.startsWith("/") ||
          template.split("/").some(
            (part) => part.startsWith(":") && !/^:[A-Za-z][A-Za-z0-9_]*$/.test(part),
          ),
      )) ||
      (hasPrefixes && target.pathPrefixes.length === 0 &&
        (!hasTemplates || target.pathTemplates.length === 0)) ||
      (hasTemplates && target.pathTemplates.length === 0 &&
        (!hasPrefixes || target.pathPrefixes.length === 0))
    ) {
      throw new Error("Invalid contribution target path rule");
    }
    if (target.excludedTemplateValues) {
      for (const [name, values] of Object.entries(target.excludedTemplateValues)) {
        if (
          !name ||
          !Array.isArray(values) ||
          values.length === 0 ||
          values.some((value) => typeof value !== "string")
        ) {
          throw new Error("Invalid contribution target template exclusion");
        }
      }
    }
    if (target.requiredSearchParams) {
      for (const [name, values] of Object.entries(target.requiredSearchParams)) {
        if (
          !name ||
          !Array.isArray(values) ||
          values.length === 0 ||
          values.some((value) => typeof value !== "string")
        ) {
          throw new Error("Invalid contribution target query rule");
        }
      }
    }
  }
  for (const agent of config.agents) {
    if (!agent.principal || !/^[a-z0-9_-]+$/i.test(agent.principal)) {
      throw new Error("Invalid principal in local config");
    }
    if (!/^[a-f0-9]{64}$/.test(agent.tokenSha256 || "")) {
      throw new Error(`Invalid token hash for ${agent.principal}`);
    }
    if (!Array.isArray(agent.capabilities)) {
      throw new Error(`Missing capabilities for ${agent.principal}`);
    }
    if (agent.confirmationPolicy !== CONFIRMATION_POLICY) {
      throw new Error(
        `P0 only supports confirmationPolicy=${CONFIRMATION_POLICY}`,
      );
    }
  }
}

export function authenticateToken(config, token) {
  if (typeof token !== "string" || token.length < 20) return null;
  const actual = Buffer.from(hashToken(token), "hex");
  for (const agent of config.agents) {
    const expected = Buffer.from(agent.tokenSha256, "hex");
    if (
      expected.length === actual.length &&
      timingSafeEqual(expected, actual)
    ) {
      return Object.freeze({
        principal: agent.principal,
        capabilities: Object.freeze([...agent.capabilities]),
        confirmationPolicy: agent.confirmationPolicy,
      });
    }
  }
  return null;
}

export async function assertAllowedUploadPath(filePath, roots) {
  if (!path.isAbsolute(filePath)) {
    throw new Error("Upload paths must be absolute");
  }
  const fileRealPath = await realpath(filePath);
  const info = await stat(fileRealPath);
  if (!info.isFile()) throw new Error("Upload target must be a regular file");

  const allowedRoots = [];
  for (const root of roots || []) {
    try {
      allowedRoots.push(await realpath(root));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const allowed = allowedRoots.some((root) => {
    const relative = path.relative(root, fileRealPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!allowed) {
    throw new Error("Upload path is outside configured upload roots");
  }
  return { filePath: fileRealPath, size: info.size };
}

export { hashToken };

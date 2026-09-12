#!/usr/bin/env node

// Completes one user-selected MiniMax work whose download menu is already open.
// No list traversal, platform API calls, Cookie reads, or fixed selectors.
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function selectNoWatermarkRef(snapshot) {
  const matches = (snapshot?.controls || []).filter((control) =>
    /^MP3\s*\(无水印\)$/.test(String(control.name || "").trim()) &&
    !control.disabled && typeof control.ref === "string",
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one visible MP3(无水印) control; found ${matches.length}`);
  }
  return matches[0].ref;
}

export async function completeOpenMiniMaxMenu({
  baseUrl = "http://127.0.0.1:3767",
  token,
  expectedTitle,
  fetchImpl = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  checkFile = stat,
}) {
  if (!token) throw new Error("ABL_TOKEN is required");
  if (!expectedTitle) throw new Error("--expected-title is required");
  const endpoint = new URL(baseUrl);
  if (!["127.0.0.1", "localhost"].includes(endpoint.hostname) || endpoint.protocol !== "http:") {
    throw new Error("Browser daemon must be local loopback HTTP");
  }
  const call = async (path, body = {}) => {
    const response = await fetchImpl(new URL(path, endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`${path}: ${payload?.error?.code || response.status}`);
    return payload.result;
  };
  const session = await call("/v1/session");
  if (!session.capabilities?.includes("browser.download.minimax") ||
      !session.capabilities?.includes("browser.download.status")) {
    throw new Error("This locally configured principal lacks MiniMax download permission");
  }
  const status = await call("/v1/status");
  if (new URL(status.url).origin !== "https://www.minimax.cn" ||
      new URL(status.url).pathname !== "/audio/music") {
    throw new Error("Open https://www.minimax.cn/audio/music first");
  }
  const before = await call("/v1/actions/download-status", { includeCompleted: true });
  const oldIds = new Set(before.downloads.map((record) => record.downloadId));
  const snapshot = await call("/v1/snapshot");
  const ref = selectNoWatermarkRef(snapshot);
  await call("/v1/actions/click", { ref });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(1000);
    const current = await call("/v1/actions/download-status", { includeCompleted: true });
    const fresh = current.downloads.filter((record) => !oldIds.has(record.downloadId));
    if (fresh.length > 1) throw new Error("Multiple new downloads appeared; verify manually");
    if (!fresh.length) continue;
    const record = fresh[0];
    if (!record.filename.startsWith(expectedTitle) || !/_no-watermark\.mp3$/i.test(record.filename)) {
      throw new Error("Downloaded file title or format does not match the selected work");
    }
    if (record.state === "failed") throw new Error(`Download failed: ${record.error || "unknown"}`);
    if (record.state !== "completed") continue;
    const file = await checkFile(record.savePath);
    if (file.size < 1024 || (record.receivedBytes > 0 && file.size !== record.receivedBytes)) {
      throw new Error("Downloaded file is empty or byte count does not match");
    }
    return {
      downloadId: record.downloadId,
      filename: record.filename,
      savePath: record.savePath,
      bytes: file.size,
    };
  }
  throw new Error("Download did not complete within 120 seconds; inspect download-status before retrying");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf("--expected-title");
  completeOpenMiniMaxMenu({
    token: process.env.ABL_TOKEN,
    expectedTitle: index >= 0 ? process.argv[index + 1] : "",
    baseUrl: process.env.ABL_BASE_URL || "http://127.0.0.1:3767",
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

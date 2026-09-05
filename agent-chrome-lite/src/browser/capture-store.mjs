import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// capture-store：滚动截屏的持久化。
//
// 每首歌一个文件夹：~/.agent-browser-local/captures/<label>-<timestamp>/
//   shot-01.png, shot-02.png, ...
//   manifest.json  —— 每屏的滚动位置、URL、时间戳、是否到底
//
// label 来自 Agent 看完第一屏截图后读出的歌名；取不到就退化为时间戳。
// 这里对 label 做严格净化：只允许字母数字、CJK、空格、连字符、下划线、
// 括号，其余全部替换为 "-"，防止路径穿越。

const LABEL_MAX_LENGTH = 64;

export function sanitizeCaptureLabel(input) {
  const cleaned = String(input || "")
    .replace(/[^\p{L}\p{N}\s\-_()（）]/gu, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^-+|-+$/g, "")
    .slice(0, LABEL_MAX_LENGTH);
  return cleaned;
}

function timestampSlug(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export class CaptureStore {
  constructor(capturesDir) {
    this.capturesDir = capturesDir;
  }

  /**
   * 开始一次滚动截屏：建目录，返回 capture 上下文。
   * label 为空时目录名退化为 "capture-<timestamp>"。
   */
  async begin(label) {
    const safeLabel = sanitizeCaptureLabel(label);
    const slug = timestampSlug();
    const dirName = safeLabel ? `${safeLabel}-${slug}` : `capture-${slug}`;
    const dir = path.join(this.capturesDir, dirName);
    // path.join 只接受相对 dirName；dirName 已净化，不含路径分隔符
    if (dirName.includes("/") || dirName.includes("\\") || dirName === "..") {
      throw new Error("invalid_capture_label");
    }
    await mkdir(dir, { recursive: true });
    return {
      captureId: randomUUID(),
      dir,
      dirName,
      label: safeLabel,
      startedAt: Date.now(),
      shots: [],
    };
  }

  /** 写一屏 PNG，登记到 manifest 数组。index 从 1 开始。 */
  async writeShot(
    capture,
    { dataBase64, pageY, viewportHeight, url, stabilitySha256, stabilityRegion },
  ) {
    const index = capture.shots.length + 1;
    const file = `shot-${String(index).padStart(2, "0")}.png`;
    const image = Buffer.from(dataBase64, "base64");
    await writeFile(path.join(capture.dir, file), image);
    const shot = {
      index,
      file,
      pageY: Math.round(Number(pageY) || 0),
      viewportHeight: Math.round(Number(viewportHeight) || 0),
      url: safeUrlForManifest(url),
      imageSha256: createHash("sha256").update(image).digest("hex"),
      stabilitySha256: stabilitySha256 || null,
      stabilityRegion: stabilityRegion || null,
      capturedAt: Date.now(),
    };
    capture.shots.push(shot);
    return shot;
  }

  /** 收尾：写 manifest.json，返回给 daemon 的最终结果。 */
  async finish(capture, { reachedEnd, stopReason }) {
    const manifest = {
      captureId: capture.captureId,
      label: capture.label || null,
      dirName: capture.dirName,
      startedAt: capture.startedAt,
      finishedAt: Date.now(),
      shotCount: capture.shots.length,
      reachedEnd: Boolean(reachedEnd),
      stopReason,
      shots: capture.shots,
    };
    await writeFile(
      path.join(capture.dir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  }
}

function safeUrlForManifest(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

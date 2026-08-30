import { app, BrowserWindow } from "electron";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BrowserController } from "../src/browser/controller.mjs";

console.error("upload-gold: main loaded");
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-browser-upload-gold-"));
app.setPath("userData", path.join(tempDir, "profile"));

let window;

function screenshotHash(result) {
  return createHash("sha256")
    .update(Buffer.from(result.dataBase64, "base64"))
    .digest("hex");
}

function semanticSignature(snapshot) {
  return snapshot.controls.map((control) => ({
    role: control.role,
    name: control.name,
    tag: control.tag,
    type: control.type,
    placeholder: control.placeholder,
    contentEditable: control.contentEditable,
    disabled: control.disabled,
  }));
}

function requireControl(snapshot, predicate, message) {
  const control = snapshot.controls.find(predicate);
  if (!control) throw new Error(message);
  return control;
}

async function run() {
  console.error("upload-gold: electron ready");
  const sampleFile = path.join(tempDir, "sample-audio.mp3");
  await writeFile(sampleFile, Buffer.from("ID3-agent-browser-upload-gold"));

  window = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const config = {
    security: {
      maxSnapshotControls: 40,
      maxSnapshotHints: 20,
    },
  };
  const controller = new BrowserController(window.webContents, config, {
    allowFileUrls: true,
  });
  await controller.initialize();
  console.error("upload-gold: CDP attached");
  await controller.navigate(
    pathToFileURL(path.join(projectDir, "test", "fixtures", "upload.html")).href,
  );

  const initialSnapshot = await controller.snapshot();
  const initialScreenshot = await controller.screenshot();
  console.error(`upload-gold: snapshot controls=${initialSnapshot.controls.length}`);
  const fileInput = requireControl(
    initialSnapshot,
    (node) => node.tag === "input" && node.type === "file",
    "Snapshot did not discover the native file input",
  );
  const notes = requireControl(
    initialSnapshot,
    (node) => node.contentEditable && /show\s*notes/i.test(node.name),
    "Snapshot did not discover the semantic Show Notes editor",
  );
  requireControl(
    initialSnapshot,
    (node) => node.type === "text" && node.placeholder === "输入单集标题",
    "Snapshot did not discover the title field",
  );
  requireControl(
    initialSnapshot,
    (node) => node.type === "submit" && node.name === "创建",
    "Snapshot did not discover the final create control",
  );
  if (
    initialSnapshot.controls.some((node) =>
      /内容管理|数据中心|测试账号/.test(node.name || ""),
    ) ||
    initialSnapshot.hints.some((hint) =>
      /内容管理|数据中心|测试账号/.test(hint.text || ""),
    )
  ) {
    throw new Error("Snapshot leaked read-only navigation or account text");
  }

  const notesText =
    "第一段：Chromium 金样保真测试。\n\n第二段：换行与链接测试。\nhttps://example.com/gold";
  await controller.fillRef(notes.ref, notesText);
  const filledSnapshot = await controller.snapshot();
  const filledNotes = requireControl(
    filledSnapshot,
    (node) => node.contentEditable && /show\s*notes/i.test(node.name),
    "Show Notes editor disappeared after fill",
  );
  if (filledNotes.value !== notesText) {
    const editorDebug = await window.webContents.executeJavaScript(`({
      innerHTML: document.querySelector('[contenteditable]').innerHTML,
      innerText: document.querySelector('[contenteditable]').innerText,
      textContent: document.querySelector('[contenteditable]').textContent
    })`);
    throw new Error(
      `Show Notes fidelity failed: ${JSON.stringify({
        snapshotValue: filledNotes.value,
        ...editorDebug,
      })}`,
    );
  }
  const freshFileInput = requireControl(
    filledSnapshot,
    (node) => node.tag === "input" && node.type === "file",
    "Native file input was not rediscovered after fill",
  );

  await controller.uploadRef(freshFileInput.ref, [sampleFile]);

  const semanticSnapshot = await controller.snapshot();
  const semanticUpload = semanticSnapshot.controls.find(
    (node) => node.role === "upload" && /上传音频/.test(node.name),
  );
  if (!semanticUpload) {
    throw new Error("Snapshot did not discover the semantic upload trigger");
  }
  const semanticResult = await controller.uploadRef(semanticUpload.ref, [sampleFile]);

  // Test-only verification of the fixture. Product actions never expose querySelector/evaluate.
  const result = await window.webContents.executeJavaScript(`({
    fileName: document.querySelector('#audio').files[0]?.name,
    status: document.querySelector('#result').textContent,
    hiddenFileName: document.querySelector('#hidden-audio').files[0]?.name,
    hiddenStatus: document.querySelector('#hidden-result').textContent
  })`);
  if (
    result.fileName !== "sample-audio.mp3" ||
    result.status !== "sample-audio.mp3" ||
    result.hiddenFileName !== "sample-audio.mp3" ||
    result.hiddenStatus !== "sample-audio.mp3"
  ) {
    throw new Error(`File binding verification failed: ${JSON.stringify(result)}`);
  }

  await controller.navigate(
    pathToFileURL(path.join(projectDir, "test", "fixtures", "upload.html")).href,
  );
  const rediscoveredSnapshot = await controller.snapshot();
  const rediscoveredScreenshot = await controller.screenshot();
  if (
    JSON.stringify(semanticSignature(initialSnapshot)) !==
    JSON.stringify(semanticSignature(rediscoveredSnapshot))
  ) {
    throw new Error("Snapshot semantic contract changed after page rediscovery");
  }
  if (initialSnapshot.snapshotId === rediscoveredSnapshot.snapshotId) {
    throw new Error("Reloaded page reused an old Snapshot epoch");
  }
  if (initialSnapshot.controls[0]?.ref === rediscoveredSnapshot.controls[0]?.ref) {
    throw new Error("Reloaded page reused an old control ref");
  }
  const firstRenderHash = screenshotHash(initialScreenshot);
  const secondRenderHash = screenshotHash(rediscoveredScreenshot);
  if (firstRenderHash !== secondRenderHash) {
    throw new Error(
      `Chromium render changed after clean rediscovery: ${firstRenderHash} != ${secondRenderHash}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mechanisms: [
          "Snapshot native ref -> backendDOMNodeId -> DOM.setFileInputFiles",
          "Snapshot semantic upload ref -> intercepted file chooser -> verified native input -> DOM.setFileInputFiles",
        ],
        contracts: [
          "semantic form discovery survives a clean reload",
          "Show Notes preserves paragraphs, line breaks and a link",
          "read-only navigation and account text stay outside Snapshot",
          "Snapshot epoch and refs are never reused",
          "deterministic fixture rendering matches across rediscovery",
        ],
        discoveredRefs: [fileInput.ref, semanticUpload.ref],
        semanticMechanism: semanticResult.mechanism,
        fileName: result.fileName,
        chromiumRenderSha256: firstRenderHash,
      },
      null,
      2,
    ),
  );
  controller.close();
  window.destroy();
  await rm(tempDir, { recursive: true, force: true });
  app.exit(0);
}

async function fail(error) {
  console.error(error);
  if (window && !window.isDestroyed()) window.destroy();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(1);
}

app.whenReady().then(run).catch(fail);

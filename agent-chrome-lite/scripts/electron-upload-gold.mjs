import { app, BrowserWindow } from "electron";
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

  const snapshot = await controller.snapshot();
  console.error(`upload-gold: snapshot controls=${snapshot.controls.length}`);
  const fileInput = snapshot.controls.find(
    (node) => node.tag === "input" && node.type === "file",
  );
  if (!fileInput) throw new Error("Snapshot did not discover the native file input");

  await controller.uploadRef(fileInput.ref, [sampleFile]);

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

  console.log(
    JSON.stringify(
      {
        ok: true,
        mechanisms: [
          "Snapshot native ref -> backendDOMNodeId -> DOM.setFileInputFiles",
          "Snapshot semantic upload ref -> intercepted file chooser -> verified native input -> DOM.setFileInputFiles",
        ],
        discoveredRefs: [fileInput.ref, semanticUpload.ref],
        semanticMechanism: semanticResult.mechanism,
        fileName: result.fileName,
      },
      null,
      2,
    ),
  );
  controller.close();
  window.destroy();
  await rm(tempDir, { recursive: true, force: true });
  app.quit();
}

async function fail(error) {
  console.error(error);
  if (window && !window.isDestroyed()) window.destroy();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(1);
}

app.whenReady().then(run).catch(fail);

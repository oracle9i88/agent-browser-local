import { app, BrowserWindow } from "electron";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CdpSession } from "../src/browser/cdp-session.mjs";
import { pointInFrame } from "../src/browser/ximalaya-publish.mjs";

console.error("frame-gold: script loaded");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "abl-frame-gold-"));
app.setPath("userData", path.join(tempDir, "profile"));
let window;
let shell;
let child;

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function run() {
  console.error("frame-gold: ready");
  child = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<button onclick="document.body.dataset.clicked=\'yes\'" style="position:fixed;bottom:10px;right:20px">确认发布</button>');
  });
  shell = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<iframe style="position:absolute;left:100px;top:80px;width:800px;height:600px;border:0" src="http://localhost:${child.address().port}/"></iframe>`);
  });
  window = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL("about:blank");
  const cdp = new CdpSession(window.webContents);
  await cdp.attach();
  console.error("frame-gold: CDP attached");
  await Promise.race([
    window.loadURL(`http://127.0.0.1:${shell.address().port}/`),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Frame fixture load timed out")), 10000)),
  ]);
  console.error("frame-gold: shell loaded");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const frames = await cdp.attachedFrames();
  console.error(`frame-gold: child targets=${frames.length}`);
  const target = frames.find((item) => item.url.startsWith(`http://localhost:${child.address().port}/`));
  if (!target) throw new Error(`OOPIF session unavailable: ${JSON.stringify(frames)}`);
  await cdp.send("DOM.enable", {}, { sessionId: target.sessionId });
  await cdp.send("Accessibility.enable", {}, { sessionId: target.sessionId });
  const ax = await cdp.send("Accessibility.getFullAXTree", {}, { sessionId: target.sessionId });
  const button = ax.nodes.find((node) => node.role?.value === "button" && node.name?.value === "确认发布");
  if (!button?.backendDOMNodeId) throw new Error("Cross-origin button missing from child AX tree");
  const quads = await cdp.send("DOM.getContentQuads", {
    backendNodeId: button.backendDOMNodeId,
  }, { sessionId: target.sessionId });
  const frameTree = await cdp.send("Page.getFrameTree", {}, { sessionId: target.sessionId });
  const owner = await cdp.send("DOM.getFrameOwner", { frameId: frameTree.frameTree.frame.id });
  const ownerQuad = await cdp.send("DOM.getContentQuads", { backendNodeId: owner.backendNodeId });
  if (!quads.quads?.[0] || !ownerQuad.quads?.[0]) throw new Error("Cross-origin geometry unavailable");
  const frameBox = await cdp.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId });
  const topMetrics = await cdp.send("Page.getLayoutMetrics");
  const topViewport = topMetrics.cssVisualViewport;
  const point = pointInFrame(quads.quads[0], ownerQuad.quads[0],
    { clientWidth: frameBox.model.width, clientHeight: frameBox.model.height }, {
      width: topViewport.clientWidth, height: topViewport.clientHeight,
    });
  if (!point) throw new Error("Cross-origin button did not map into host viewport");
  const localPoint = {
    x: (quads.quads[0][0] + quads.quads[0][2]) / 2,
    y: (quads.quads[0][1] + quads.quads[0][5]) / 2,
  };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...localPoint,
    button: "none" }, { sessionId: target.sessionId });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...localPoint,
    button: "left", buttons: 1, clickCount: 1 }, { sessionId: target.sessionId });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...localPoint,
    button: "left", buttons: 0, clickCount: 1 }, { sessionId: target.sessionId });
  const afterChildClick = await cdp.send("Runtime.evaluate", {
    expression: "document.body.dataset.clicked", returnByValue: true,
  }, { sessionId: target.sessionId });
  if (afterChildClick.result?.value !== "yes") throw new Error("Child CDP input did not reach fixed iframe button");
  console.log(JSON.stringify({ ok: true, crossOriginFrame: true, button: button.name.value,
    fixedFooterClickReachedButton: true }));
  cdp.detach();
}

app.whenReady().then(async () => {
  let success = false;
  try {
    await run();
    success = true;
  } catch (error) {
    console.error(error);
  } finally {
    window?.destroy();
    shell?.closeAllConnections();
    child?.closeAllConnections();
    await Promise.all([shell, child].filter(Boolean).map((server) =>
      new Promise((resolve) => server.close(resolve))));
    await rm(tempDir, { recursive: true, force: true });
    if (!success) process.exit(1);
    app.exit(0);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

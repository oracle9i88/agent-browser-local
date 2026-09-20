const UPLOAD_SHELL = "https://studio.ximalaya.com";
const UPLOAD_FRAME = "https://www.ximalaya.com";

export function isXimalayaUploadShell(value) {
  try {
    const url = new URL(value);
    return url.origin === UPLOAD_SHELL &&
      (url.pathname === "/upload" || url.pathname === "/uploadWorks");
  } catch {
    return false;
  }
}

export function isXimalayaUploadFrame(value) {
  try {
    const url = new URL(value);
    return url.origin === UPLOAD_FRAME &&
      url.pathname.startsWith("/reform-upload/page/");
  } catch {
    return false;
  }
}

function value(property) {
  return String(property?.value || "").replace(/\s+/g, "").trim();
}

export function uniquePublishButton(nodes) {
  const matches = (nodes || []).filter((node) =>
    !node.ignored &&
    value(node.role) === "button" &&
    value(node.name) === "确认发布" &&
    node.backendDOMNodeId &&
    !node.properties?.some((property) =>
      property.name === "disabled" && property.value?.value === true),
  );
  if (matches.length !== 1) {
    const error = new Error(
      matches.length ? "More than one publish button is present" : "Publish button is not accessible",
    );
    error.code = "ximalaya_publish_target_unavailable";
    throw error;
  }
  return matches[0].backendDOMNodeId;
}

function bounds(quad) {
  if (!Array.isArray(quad) || quad.length !== 8 ||
      !quad.every(Number.isFinite)) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    left: Math.min(...xs), right: Math.max(...xs),
    top: Math.min(...ys), bottom: Math.max(...ys),
  };
}

export function pointInFrame(buttonQuad, frameQuad, childViewport, topViewport) {
  const button = bounds(buttonQuad);
  const frame = bounds(frameQuad);
  const width = Number(childViewport?.clientWidth);
  const height = Number(childViewport?.clientHeight);
  if (!button || !frame || !width || !height ||
      width <= 0 || height <= 0 ||
      // A transformed iframe cannot be mapped safely using axis-aligned geometry.
      Math.abs(frameQuad[1] - frameQuad[3]) > 1 ||
      Math.abs(frameQuad[5] - frameQuad[7]) > 1 ||
      Math.abs(frameQuad[0] - frameQuad[6]) > 1 ||
      Math.abs(frameQuad[2] - frameQuad[4]) > 1) return null;
  const localX = (button.left + button.right) / 2;
  const localY = (button.top + button.bottom) / 2;
  if (localX < 0 || localX >= width || localY < 0 || localY >= height) return null;
  const x = frame.left + localX * (frame.right - frame.left) / width;
  const y = frame.top + localY * (frame.bottom - frame.top) / height;
  if (x < 0 || y < 0 || x >= topViewport.width || y >= topViewport.height ||
      x < frame.left || x >= frame.right || y < frame.top || y >= frame.bottom) {
    return null;
  }
  return { x, y };
}

export function collectUploadFramesInTree(frameTree) {
  const matches = [];
  const seen = [];
  const stack = [frameTree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.frame?.url) seen.push(node.frame.url);
    if (isXimalayaUploadFrame(node.frame?.url)) matches.push(node.frame);
    for (const child of node.childFrames || []) stack.push(child);
  }
  return { matches, seen };
}

const FIND_PUBLISH_BUTTON_SOURCE = `(() => {
  const buttons = [...document.querySelectorAll("button")].filter((el) => {
    const name = String(el.textContent || "").replace(/\\s+/g, "").trim();
    if (name !== "确认发布" || el.disabled ||
        el.getAttribute("aria-disabled") === "true") return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== "hidden" && style.display !== "none";
  });
  if (buttons.length !== 1) return { count: buttons.length };
  const el = buttons[0];
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  return { count: 1, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
})()`;

async function probePublishButton(cdp, frameId) {
  const world = await cdp.send("Page.createIsolatedWorld", {
    frameId,
    worldName: "abl-ximalaya-publish",
    grantUniveralAccess: false,
  });
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: FIND_PUBLISH_BUTTON_SOURCE,
    contextId: world.executionContextId,
    returnByValue: true,
  });
  if (evaluation?.exceptionDetails) return null;
  const found = evaluation?.result?.value;
  return found && found.count === 1 ? found : null;
}

async function locateViaIsolatedWorld(cdp, viewport) {
  // studio.ximalaya.com and www.ximalaya.com are the same site, so the
  // upload iframe stays in-process and never appears as an OOPIF target.
  // Walk the frame tree on the main session and inspect the child document
  // through an isolated world instead. The page may embed the upload frame
  // more than once (e.g. a hidden legacy copy); disambiguate by probing
  // each candidate for a unique visible publish button.
  const tree = await cdp.send("Page.getFrameTree");
  const { matches, seen } = collectUploadFramesInTree(tree.frameTree);
  if (matches.length === 0) {
    const error = new Error(
      `Expected at least one Ximalaya upload iframe. ` +
      `Frame URLs: ${seen.slice(0, 10).join(" | ") || "(none)"}`,
    );
    error.code = "ximalaya_upload_frame_unavailable";
    throw error;
  }
  await cdp.send("Runtime.enable");
  const hits = [];
  for (const frame of matches) {
    const found = await probePublishButton(cdp, frame.id);
    if (found) hits.push({ frame, found });
  }
  if (hits.length !== 1) {
    const error = new Error(
      hits.length > 1
        ? "More than one publish button is present"
        : "Publish button is not accessible",
    );
    error.code = "ximalaya_publish_target_unavailable";
    throw error;
  }
  const { frame, found } = hits[0];
  const frameOwner = await cdp.send("DOM.getFrameOwner", { frameId: frame.id });
  const [{ quads: frameQuads }, frameBox] = await Promise.all([
    cdp.send("DOM.getContentQuads", { backendNodeId: frameOwner.backendNodeId }),
    cdp.send("DOM.getBoxModel", { backendNodeId: frameOwner.backendNodeId }),
  ]);
  const buttonQuad = [
    found.x, found.y,
    found.x + found.width, found.y,
    found.x + found.width, found.y + found.height,
    found.x, found.y + found.height,
  ];
  const point = pointInFrame(
    buttonQuad, frameQuads?.[0],
    { clientWidth: frameBox.model?.width, clientHeight: frameBox.model?.height },
    viewport,
  );
  if (!point) {
    const error = new Error("Publish button is not safely visible in the current viewport");
    error.code = "ximalaya_publish_target_unavailable";
    throw error;
  }
  const url = new URL(frame.url);
  return {
    point,
    // An in-process frame has no child session; click on the main session
    // at the mapped top-viewport point.
    childPoint: point,
    sessionId: undefined,
    frameUrl: `${url.origin}${url.pathname}`,
    node: { tag: "button", role: "button", name: "确认发布" },
  };
}

export async function locateXimalayaPublish(cdp, topUrl, viewport) {
  if (!isXimalayaUploadShell(topUrl)) {
    const error = new Error("Ximalaya upload page is required");
    error.code = "ximalaya_upload_required";
    throw error;
  }
  const frames = (await cdp.attachedFrames())
    .filter((frame) => isXimalayaUploadFrame(frame.url));
  if (frames.length === 0) return locateViaIsolatedWorld(cdp, viewport);
  if (frames.length !== 1) {
    const error = new Error("Expected exactly one Ximalaya upload iframe");
    error.code = "ximalaya_upload_frame_unavailable";
    throw error;
  }
  const { sessionId, url } = frames[0];
  // The target may have navigated between discovery and attachment.
  const childTree = await cdp.send("Page.getFrameTree", {}, { sessionId });
  if (!isXimalayaUploadFrame(childTree.frameTree?.frame?.url)) {
    const error = new Error("Ximalaya upload iframe changed during inspection");
    error.code = "ximalaya_upload_frame_unavailable";
    throw error;
  }
  await cdp.send("DOM.enable", {}, { sessionId });
  await cdp.send("Accessibility.enable", {}, { sessionId });
  const ax = await cdp.send("Accessibility.getFullAXTree", {}, { sessionId });
  const backendNodeId = uniquePublishButton(ax.nodes);
  const [{ quads: buttonQuads }, frameOwner] = await Promise.all([
    cdp.send("DOM.getContentQuads", { backendNodeId }, { sessionId }),
    cdp.send("DOM.getFrameOwner", { frameId: childTree.frameTree.frame.id }),
  ]);
  const [{ quads: frameQuads }, frameBox] = await Promise.all([
    cdp.send("DOM.getContentQuads", { backendNodeId: frameOwner.backendNodeId }),
    cdp.send("DOM.getBoxModel", { backendNodeId: frameOwner.backendNodeId }),
  ]);
  const point = pointInFrame(
    buttonQuads?.[0], frameQuads?.[0],
    { clientWidth: frameBox.model?.width, clientHeight: frameBox.model?.height },
    viewport,
  );
  if (!point) {
    const error = new Error("Publish button is not safely visible in the current viewport");
    error.code = "ximalaya_publish_target_unavailable";
    throw error;
  }
  return {
    point,
    childPoint: {
      x: (buttonQuads[0][0] + buttonQuads[0][2] + buttonQuads[0][4] + buttonQuads[0][6]) / 4,
      y: (buttonQuads[0][1] + buttonQuads[0][3] + buttonQuads[0][5] + buttonQuads[0][7]) / 4,
    },
    sessionId,
    frameUrl: `${new URL(url).origin}${new URL(url).pathname}`,
    node: { tag: "button", role: "button", name: "确认发布" },
  };
}

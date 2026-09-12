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

export async function locateXimalayaPublish(cdp, topUrl, viewport) {
  if (!isXimalayaUploadShell(topUrl)) {
    const error = new Error("Ximalaya upload page is required");
    error.code = "ximalaya_upload_required";
    throw error;
  }
  const frames = (await cdp.attachedFrames())
    .filter((frame) => isXimalayaUploadFrame(frame.url));
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

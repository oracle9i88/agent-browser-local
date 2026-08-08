import { randomUUID } from "node:crypto";

import { isReadOnlyPlatformPath } from "../security/contribution-policy.mjs";

const CONTROL_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

const HINT_ROLES = new Set([
  "alert",
  "heading",
  "paragraph",
  "status",
  "StaticText",
]);

const RECORD_DATE = /(?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2}/;
const UPLOAD_HINT = /^(?:click\s+to\s+)?upload(?:\s+(?:audio|video|file|cover))?$|choose\s+(?:a\s+)?file|select\s+(?:a\s+)?file|^(?:点击)?上传(?:音频|视频|文件|封面)?$|点击上传|拖(?:拽|入).*(?:上传|选择)|选择(?:音频|视频|文件|封面)(?:文件)?$/i;
const EDITOR_HINT = /show\s*notes|description|body|editor|notes|简介|正文|内容|说明|编辑/i;
const SEMANTIC_EDIT_HINT = /title|headline|show\s*notes|description|body|editor|notes|(?:请输入|输入|填写|写).*标题|(?:开始写|输入|编辑).*正文/i;
const READ_ONLY_CONTROL_NAME = /(?:^|\s)(?:dashboard|analytics|insights|statistics|stats|comments?|messages?|notifications?|subscribers?|followers?|fans?|earnings?|revenue|income|help(?:\s+center)?|customer\s+service|account(?:\s+settings)?|profile|home)(?:\s|$)|^(?:首页|主页|消息|通知|在线客服|帮助中心|问题咨询|个人信息|设置|通知中心|草稿箱|成长中心|创作服务|其他服务|活动中心|活动管理|变现中心|创作中心|数据概览|作品分析|直播数据|粉丝分析|创作灵感|热点榜单|创作学院|音乐人|推广资源管理)$|内容管理|互动管理|数据中心|数据分析|直播管理|视频管理|我的作品|创作收益|收入与服务|带货中心|作品推广|创作成长|创作实验室|账号服务|专辑分类|定时发布|关于腾讯|运营规范/i;
const CONTRIBUTION_HINT = /upload|choose\s+(?:a\s+)?file|select\s+(?:a\s+)?file|title|description|show\s*notes|body|editor|notes|cover|agreement|publish|submit|schedule|draft|preview|link|location|collection|original|tags?|topics?|标题|描述|简介|正文|说明|编辑|上传|选择文件|封面|协议|创建单集|链接|声明原创|原创|标注|位置|合集|活动|定时|不定时|话题|添加描述|保存草稿|手机预览|发表|视频|图文|音乐|音频/i;

function axValue(value) {
  return value && typeof value === "object" && "value" in value
    ? value.value
    : value;
}

function axProperty(node, name) {
  return axValue(node.properties?.find((item) => item.name === name)?.value);
}

function compactText(value, max = 500) {
  return String(value || "").replace(/\u0000/g, "").slice(0, max);
}

function descendantText(node, nodesById) {
  const pending = [...(node.childIds || [])];
  let visited = 0;
  while (pending.length && visited < 80) {
    visited += 1;
    const child = nodesById.get(pending.shift());
    if (!child) continue;
    const role = compactText(axValue(child.role), 80);
    const name = compactText(axValue(child.name), 200);
    if (name && HINT_ROLES.has(role)) return name;
    pending.push(...(child.childIds || []));
  }
  return "";
}

function nearestBackendNodeId(node, nodesById) {
  let current = node;
  let depth = 0;
  while (current && depth < 16) {
    if (current.backendDOMNodeId) return current.backendDOMNodeId;
    current = nodesById.get(current.parentId);
    depth += 1;
  }
  return null;
}

export function isReadOnlyLink(control, pageUrl) {
  if (control.role !== "link" || !control.href) return false;
  try {
    const href = new URL(control.href, pageUrl);
    const page = new URL(pageUrl);
    if (href.origin !== page.origin) return true;
    if (isReadOnlyPlatformPath(href.pathname)) return true;
  } catch {
    return true;
  }
  return RECORD_DATE.test(control.name || "");
}

export function isReadOnlyControl(control, pageUrl) {
  if (READ_ONLY_CONTROL_NAME.test(control.name || "")) return true;
  if (control.role === "link" && /logo$/i.test(control.name || "")) return true;
  return isReadOnlyLink(control, pageUrl);
}

export function isContributionHint(text) {
  const value = compactText(text, 500).trim();
  if (!value || READ_ONLY_CONTROL_NAME.test(value)) return false;
  if (/^©|all rights reserved|wideNavigation|视频号\s*[·•]\s*助手/i.test(value)) {
    return false;
  }
  return CONTRIBUTION_HINT.test(value);
}

export class SnapshotStore {
  constructor({ maxControls = 180, maxHints = 80 } = {}) {
    this.maxControls = maxControls;
    this.maxHints = maxHints;
    this.invalidate();
  }

  invalidate() {
    this.epoch = null;
    this.refs = new Map();
  }

  resolve(ref) {
    const entry = this.refs.get(ref);
    if (!entry) {
      const error = new Error("Snapshot ref is stale or unknown; take a fresh snapshot");
      error.code = "stale_ref";
      throw error;
    }
    return entry;
  }

  async captureStable(
    cdp,
    page,
    { attempts = 3, intervalMs = 400, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
  ) {
    let result;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      result = await this.capture(cdp, page);
      if (result.controls.length > 0 || attempt === attempts - 1) return result;
      await wait(intervalMs);
    }
    return result;
  }

  async capture(cdp, { title, url }) {
    const { nodes = [] } = await cdp.send("Accessibility.getFullAXTree");
    const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
    const epoch = randomUUID().slice(0, 8);
    const controls = [];
    const candidateHints = [];
    const refs = new Map();

    for (const node of nodes) {
      if (node.ignored) continue;
      const role = compactText(axValue(node.role), 80);
      const name = compactText(axValue(node.name), 500);
      const backendNodeId = node.backendDOMNodeId;
      const isControl = backendNodeId && CONTROL_ROLES.has(role);

      if (isControl && controls.length < this.maxControls) {
        const metadata = await readNodeMetadata(cdp, backendNodeId).catch(() => ({}));
        const isFileInput = metadata.tag === "input" && metadata.type === "file";
        if (metadata.visible === false && !isFileInput) continue;
        const ref = `${epoch}:${controls.length + 1}`;
        const control = {
          ref,
          ...metadata,
          role: role || metadata.role || "control",
          name:
            name ||
            metadata.ariaLabel ||
            metadata.placeholder ||
            (metadata.contentEditable ? descendantText(node, nodesById) : ""),
          value: compactText(
            metadata.contentEditable && typeof metadata.value === "string"
              ? metadata.value
              : axValue(node.value) || metadata.value,
            500,
          ),
          disabled: Boolean(axProperty(node, "disabled") || metadata.disabled),
          checked:
            axProperty(node, "checked") ??
            (typeof metadata.checked === "boolean" ? metadata.checked : undefined),
        };
        delete control.visible;
        if (
          control.contentEditable &&
          String(control.value || "").replace(/\s+/g, "") ===
            String(control.name || "").replace(/\s+/g, "")
        ) {
          control.value = "";
        }
        if (isReadOnlyControl(control, url)) continue;
        controls.push(control);
        refs.set(ref, { backendNodeId, node: control });
        continue;
      }

      if (
        backendNodeId &&
        name &&
        HINT_ROLES.has(role) &&
        UPLOAD_HINT.test(name) &&
        controls.length < this.maxControls
      ) {
        const metadata = await readNodeMetadata(cdp, backendNodeId).catch(() => ({}));
        if (metadata.visible !== false) {
          const ref = `${epoch}:${controls.length + 1}`;
          const control = {
            ref,
            role: "upload",
            name,
            value: "",
            disabled: Boolean(metadata.disabled),
            ...metadata,
          };
          delete control.visible;
          controls.push(control);
          refs.set(ref, { backendNodeId, node: control });
        }
      }

      if (
        name &&
        HINT_ROLES.has(role) &&
        candidateHints.length < this.maxHints &&
        name.length <= 500 &&
        isContributionHint(name)
      ) {
        candidateHints.push({ role, text: name });
      }
    }

    // Some rich editors expose only their placeholder text in the AX tree and
    // omit the surrounding contenteditable element as an actionable AX node.
    // Start from that semantic AX hint, then mechanically map its DOM ancestry
    // to the nearest editable element. This remains ref-based semantic
    // discovery: CSS, XPath and fixed coordinates are never used as locators.
    if (controls.length < this.maxControls) {
      for (const node of nodes) {
        if (
          node.ignored ||
          !HINT_ROLES.has(compactText(axValue(node.role), 80))
        ) {
          continue;
        }
        const semanticName = compactText(axValue(node.name), 500).trim();
        if (!semanticName || !SEMANTIC_EDIT_HINT.test(semanticName)) continue;
        const semanticBackendNodeId = nearestBackendNodeId(node, nodesById);
        if (!semanticBackendNodeId) continue;
        const candidate = await resolveEditableFromSemanticHint(
          cdp,
          semanticBackendNodeId,
          semanticName,
        ).catch(() => null);
        if (!candidate?.backendNodeId) {
          const metadata = await readNodeMetadata(
            cdp,
            semanticBackendNodeId,
          ).catch(() => ({}));
          if (metadata.visible === false) continue;
          const ref = `${epoch}:${controls.length + 1}`;
          const control = {
            ref,
            role: "editor_activation",
            name: semanticName,
            value: "",
            disabled: Boolean(metadata.disabled),
            ...metadata,
          };
          delete control.visible;
          controls.push(control);
          refs.set(ref, { backendNodeId: semanticBackendNodeId, node: control });
          if (controls.length >= this.maxControls) break;
          continue;
        }
        if (candidate.metadata?.visible === false) continue;
        if (
          [...refs.values()].some(
            (entry) => entry.backendNodeId === candidate.backendNodeId,
          )
        ) {
          continue;
        }
        const ref = `${epoch}:${controls.length + 1}`;
        const metadata = candidate.metadata || {};
        const normalizedValue = String(metadata.value || "").replace(/\s+/g, "");
        const normalizedSemanticName = semanticName.replace(/\s+/g, "");
        const control = {
          ref,
          ...metadata,
          role: metadata.role || "textbox",
          name:
            metadata.ariaLabel ||
            metadata.placeholder ||
            metadata.title ||
            semanticName,
          value: compactText(
            metadata.contentEditable && normalizedValue === normalizedSemanticName
              ? ""
              : metadata.value,
            500,
          ),
          disabled: Boolean(metadata.disabled),
          checked:
            typeof metadata.checked === "boolean" ? metadata.checked : undefined,
        };
        delete control.visible;
        if (isReadOnlyControl(control, url)) continue;
        controls.push(control);
        refs.set(ref, { backendNodeId: candidate.backendNodeId, node: control });
        if (controls.length >= this.maxControls) break;
      }
    }

    const contributionForm = controls.some(
      (control) =>
        control.contentEditable ||
        control.formAction ||
        ["checkbox", "file", "radio", "text", "textarea"].includes(control.type),
    );

    const editorHint = candidateHints.find((hint) => EDITOR_HINT.test(hint.text));
    if (editorHint) {
      for (const control of controls) {
        if (control.contentEditable && !control.name) {
          control.name = editorHint.text;
        }
      }
    }

    // Native file inputs are commonly display:none and therefore ignored by the
    // accessibility tree. They are still discovered from ignored AX nodes, then
    // bound to backendDOMNodeId for the CDP setFileInputFiles mechanism. No
    // selector, XPath, page script, or fixed coordinate is used as a locator.
    if (contributionForm && controls.length < this.maxControls) {
      let inspected = 0;
      for (const node of nodes) {
        if (!node.ignored || !node.backendDOMNodeId || inspected >= 240) continue;
        inspected += 1;
        const metadata = await readNodeMetadata(cdp, node.backendDOMNodeId).catch(() => ({}));
        if (metadata.tag !== "input" || metadata.type !== "file") continue;
        const ref = `${epoch}:${controls.length + 1}`;
        const control = {
          ref,
          role: "file",
          name: metadata.ariaLabel || metadata.placeholder || metadata.title || "文件上传",
          value: "",
          disabled: Boolean(metadata.disabled),
          ...metadata,
        };
        delete control.visible;
        controls.push(control);
        refs.set(ref, { backendNodeId: node.backendDOMNodeId, node: control });
        if (controls.length >= this.maxControls) break;
      }
    }

    const hints = contributionForm ? candidateHints : [];

    this.epoch = epoch;
    this.refs = refs;
    return {
      snapshotId: epoch,
      title,
      url,
      controls,
      hints,
      limits: {
        controls: this.maxControls,
        hints: this.maxHints,
        collectionMode: "contribution-only",
      },
    };
  }
}

export async function resolveEditableFromSemanticHint(
  cdp,
  backendNodeId,
  semanticName = "",
) {
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId });
  if (!object?.objectId) return null;
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    returnByValue: false,
    arguments: [{ value: semanticName }],
    functionDeclaration: `function (semanticName) {
      const asElement = (node) =>
        node?.nodeType === 1 ? node : node?.parentElement || null;
      const normalize = (value) =>
        String(value || "").replace(/\\s+/g, "").toLowerCase();
      const isEditable = (element) => {
        if (!element) return false;
        const tag = (element.tagName || "").toLowerCase();
        return element.isContentEditable || tag === "input" || tag === "textarea";
      };
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect?.();
        const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
        return Boolean(
          rect && rect.width > 0 && rect.height > 0 && style &&
          style.visibility !== "hidden" && style.display !== "none"
        );
      };
      const semantic = normalize(semanticName);
      const anchor = asElement(this);
      let current = anchor;
      let depth = 0;
      while (current && depth < 12) {
        if (isEditable(current)) return current;
        current = current.parentElement;
        depth += 1;
      }
      current = anchor;
      depth = 0;
      while (current && depth < 8) {
        const pending = Array.from(current.children || []);
        const candidates = [];
        let visited = 0;
        while (pending.length && visited < 180) {
          visited += 1;
          const child = pending.shift();
          if (isEditable(child) && isVisible(child)) {
            const label = normalize(
              child.getAttribute?.("aria-label") ||
              child.getAttribute?.("placeholder") ||
              child.getAttribute?.("data-placeholder") ||
              child.getAttribute?.("aria-placeholder") ||
              child.getAttribute?.("title")
            );
            if (label && semantic && (label.includes(semantic) || semantic.includes(label))) {
              return child;
            }
            candidates.push(child);
          }
          pending.push(...Array.from(child.children || []));
        }
        if (candidates.length === 1) return candidates[0];
        current = current.parentElement;
        depth += 1;
      }
      return null;
    }`,
  });
  if (!result.result?.objectId || result.result.subtype === "null") return null;
  const described = await cdp.send("DOM.describeNode", {
    objectId: result.result.objectId,
  });
  const candidateBackendNodeId = described.node?.backendNodeId;
  if (!candidateBackendNodeId) return null;
  return {
    backendNodeId: candidateBackendNodeId,
    metadata: await readNodeMetadata(cdp, candidateBackendNodeId),
  };
}

export async function readNodeMetadata(cdp, backendNodeId) {
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId });
  if (!object?.objectId) return {};
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    returnByValue: true,
    functionDeclaration: `function () {
      const rect = this.getBoundingClientRect?.();
      const style = this.ownerDocument?.defaultView?.getComputedStyle?.(this);
      const tag = (this.tagName || "").toLowerCase();
      const descendantPlaceholder = (root) => {
        const pending = Array.from(root.children || []);
        let visited = 0;
        while (pending.length && visited < 80) {
          visited += 1;
          const child = pending.shift();
          const value =
            child.getAttribute?.("data-placeholder") ||
            child.getAttribute?.("placeholder") ||
            child.getAttribute?.("aria-placeholder");
          if (value) return value;
          pending.push(...Array.from(child.children || []));
        }
        return "";
      };
      const serializeEditable = (root) => {
        const blockTags = new Set([
          "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "FIGCAPTION",
          "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6",
          "HEADER", "LI", "MAIN", "NAV", "P", "PRE", "SECTION"
        ]);
        const inlineText = (node) => {
          if (node.nodeType === 3) return node.nodeValue || "";
          if (node.nodeType !== 1) return "";
          if (node.tagName === "BR") return "\\n";
          return Array.from(node.childNodes || []).map(inlineText).join("");
        };
        const collectLines = (node) => {
          const lines = [];
          let inlineBuffer = "";
          const flushInline = () => {
            if (!inlineBuffer) return;
            lines.push(inlineBuffer);
            inlineBuffer = "";
          };
          for (const child of Array.from(node.childNodes || [])) {
            if (child.nodeType === 1 && blockTags.has(child.tagName)) {
              flushInline();
              const childLines = collectLines(child);
              lines.push(...(childLines.length ? childLines : [""]));
              continue;
            }
            if (child.nodeType === 1 && child.tagName === "BR") {
              lines.push(inlineBuffer);
              inlineBuffer = "";
              continue;
            }
            inlineBuffer += inlineText(child);
          }
          flushInline();
          return lines;
        };
        return collectLines(root).join("\\n");
      };
      const resolvedPlaceholder =
        this.getAttribute?.("placeholder") ||
        this.getAttribute?.("data-placeholder") ||
        (this.isContentEditable ? descendantPlaceholder(this) : "");
      const editableText = this.isContentEditable ? serializeEditable(this) : undefined;
      const normalizedEditable = String(editableText || "").replace(/\\s+/g, "");
      const normalizedPlaceholder = String(resolvedPlaceholder || "").replace(/\\s+/g, "");
      const contentValue =
        normalizedPlaceholder && normalizedEditable === normalizedPlaceholder
          ? ""
          : editableText;
      const value = tag === "input" || tag === "textarea" || tag === "select"
        ? this.value
        : contentValue;
      return {
        tag,
        type: (this.getAttribute?.("type") || this.type || "").toLowerCase(),
        nameAttr: this.getAttribute?.("name") || "",
        ariaLabel: this.getAttribute?.("aria-label") || "",
        placeholder: resolvedPlaceholder,
        title: this.getAttribute?.("title") || "",
        href: this.href || this.getAttribute?.("href") || "",
        formAction: this.form?.action || this.getAttribute?.("formaction") || "",
        formMethod: this.form?.method || "",
        autocomplete: this.getAttribute?.("autocomplete") || "",
        contentEditable: Boolean(this.isContentEditable),
        disabled: Boolean(this.disabled || this.getAttribute?.("aria-disabled") === "true"),
        checked: typeof this.checked === "boolean" ? this.checked : undefined,
        value: typeof value === "string" ? value.slice(0, 500) : "",
        visible: Boolean(rect && rect.width > 0 && rect.height > 0 && style && style.visibility !== "hidden" && style.display !== "none")
      };
    }`,
  });
  return result.result?.value || {};
}

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
const UPLOAD_HINT = /upload|choose\s+(?:a\s+)?file|select\s+(?:a\s+)?file|上传(?:音频|文件|封面)?|选择(?:音频|文件|封面)/i;
const EDITOR_HINT = /show\s*notes|description|body|editor|notes|简介|正文|内容|说明|编辑/i;
const READ_ONLY_CONTROL_NAME = /(?:^|\s)(?:dashboard|analytics|insights|statistics|stats|comments?|messages?|notifications?|subscribers?|followers?|fans?|earnings?|revenue|income|help(?:\s+center)?|customer\s+service|account(?:\s+settings)?|profile|home)(?:\s|$)|^(?:首页|主页|消息|在线客服|帮助中心|问题咨询|个人信息|设置|通知中心|草稿箱)$|内容管理|互动管理|数据中心|数据分析|直播管理|视频管理|我的作品|创作收益|收入与服务|带货中心|作品推广|创作成长|创作实验室|账号服务|专辑分类|定时发布|关于腾讯|运营规范/i;
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
          ...metadata,
        };
        delete control.visible;
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
        const containerTags = new Set([
          "ARTICLE", "ASIDE", "DIV", "FIGURE", "MAIN", "NAV", "SECTION"
        ]);
        const collectBlocks = (node, isRoot = false) => {
          const nestedBlocks = Array.from(node.children || []).filter((child) =>
            blockTags.has(child.tagName)
          );
          if (
            nestedBlocks.length &&
            (isRoot || containerTags.has(node.tagName))
          ) {
            return nestedBlocks.flatMap((child) => collectBlocks(child, false));
          }
          return [inlineText(node).replace(/\\n+$/g, "")];
        };
        return collectBlocks(root, true).join("\\n");
      };
      const editableText = this.isContentEditable ? serializeEditable(this) : undefined;
      const value = tag === "input" || tag === "textarea" || tag === "select"
        ? this.value
        : editableText;
      return {
        tag,
        type: (this.getAttribute?.("type") || this.type || "").toLowerCase(),
        nameAttr: this.getAttribute?.("name") || "",
        ariaLabel: this.getAttribute?.("aria-label") || "",
        placeholder:
          this.getAttribute?.("placeholder") ||
          this.getAttribute?.("data-placeholder") ||
          (this.isContentEditable ? descendantPlaceholder(this) : ""),
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

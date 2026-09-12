import path from "node:path";

import { assertAllowedUploadPath } from "../config.mjs";
import { CAPABILITIES } from "../constants.mjs";
import { assertContributionUrl } from "../security/contribution-policy.mjs";
import {
  classifyAction,
  classifySnapshotSurface,
} from "../security/risk-policy.mjs";

export class DaemonError extends Error {
  constructor(status, code, message, detail = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || "").slice(0, 500);
  }
}

export class BrowserDaemon {
  constructor({ controller, config, executor, audit }) {
    this.controller = controller;
    this.config = config;
    this.executor = executor;
    this.audit = audit;
    this.controller.on?.("download", (entry) => {
      void this.audit.record({
        ...entry,
        url: safeUrl(this.controller.status().url),
      }).catch(() => undefined);
    });
  }

  requireCapability(identity, capability) {
    if (!identity?.capabilities?.includes(capability)) {
      throw new DaemonError(
        403,
        "capability_denied",
        `Principal is not allowed to use ${capability}`,
      );
    }
  }

  requireContributionPage(url = this.controller.status().url) {
    try {
      assertContributionUrl(this.config, url);
    } catch (error) {
      throw new DaemonError(403, error.code, error.message);
    }
  }

  requireSunoStudioPage(url = this.controller.status().url) {
    try {
      const parsed = new URL(url);
      if (
        parsed.origin !== "https://suno.com" ||
        (parsed.pathname !== "/studio" && !parsed.pathname.startsWith("/studio/"))
      ) {
        throw new Error("outside Suno Studio");
      }
    } catch {
      throw new DaemonError(
        403,
        "suno_studio_required",
        "This capability is restricted to https://suno.com/studio",
      );
    }
  }

  requireNoHandoff() {
    const handoff = this.controller.status().handoff;
    if (handoff?.required) {
      throw new DaemonError(
        409,
        "handoff_pending",
        "Automation is paused until the user clears the handoff in the browser UI",
        { handoff },
      );
    }
  }

  async reconcileDelegatedContributionHandoff(identity) {
    const handoff = this.controller.status().handoff;
    if (
      handoff?.detail?.code !== "outside_contribution_scope" ||
      !identity.capabilities.includes(CAPABILITIES.FINALIZE)
    ) {
      return false;
    }
    this.requireContributionPage();
    this.controller.clearHandoff();
    await this.audit.record({
      event: "handoff.auto_resumed",
      principal: identity.principal,
      code: handoff.detail.code,
      url: safeUrl(this.controller.status().url),
    });
    return true;
  }

  async reconcileNavigateHandoff(identity, targetUrl) {
    const handoff = this.controller.status().handoff;
    if (!handoff?.required) return false;
    if (handoff?.detail?.code !== "outside_contribution_scope") return false;
    // The target URL has already passed requireContributionPage by the caller,
    // so navigating back into contribution scope is the intended recovery path
    // for an out-of-scope handoff (controller.navigate clears handoff itself).
    this.controller.clearHandoff();
    await this.audit.record({
      event: "handoff.auto_resumed",
      principal: identity.principal,
      code: handoff.detail.code,
      via: "browser.navigate",
      url: safeUrl(targetUrl),
    });
    return true;
  }

  async blocked(identity, risk, context) {
    const handoff = this.controller.setHandoff(risk.reason, {
      code: risk.code,
      action: context.action,
      ref: context.ref,
    });
    await this.audit.record({
      event: "action.blocked",
      principal: identity.principal,
      policy: identity.confirmationPolicy,
      code: risk.code,
      action: context.action,
      ref: context.ref,
      url: safeUrl(this.controller.status().url),
    });
    throw new DaemonError(409, risk.code, risk.reason, { handoff });
  }

  async recordDelegatedAction(identity, risk, context) {
    await this.audit.record({
      event: "action.delegated",
      principal: identity.principal,
      capability: risk.delegableCapability,
      code: risk.code,
      action: context.action,
      ref: context.ref,
      url: safeUrl(this.controller.status().url),
    });
  }

  async dispatch(identity, method, params = {}) {
    switch (method) {
      case "session.get":
        return {
          principal: identity.principal,
          capabilities: [...identity.capabilities],
          confirmationPolicy: identity.confirmationPolicy,
          constitution: "contribution-only",
        };

      case "browser.status":
        this.requireCapability(identity, CAPABILITIES.STATUS);
        return this.controller.status();

      case "browser.navigate": {
        this.requireCapability(identity, CAPABILITIES.NAVIGATE);
        this.requireContributionPage(params.url);
        return this.executor.run(async () => {
          // Keep the handoff in place while this action waits in the queue.
          if (!(await this.reconcileNavigateHandoff(identity, params.url))) {
            this.requireNoHandoff();
          }
          const result = await this.controller.navigate(params.url);
          await this.audit.record({
            event: "browser.navigate",
            principal: identity.principal,
            url: safeUrl(result.url),
          });
          return result;
        });
      }

      case "browser.snapshot": {
        this.requireCapability(identity, CAPABILITIES.SNAPSHOT);
        await this.reconcileDelegatedContributionHandoff(identity);
        this.requireNoHandoff();
        this.requireContributionPage();
        const result = await this.controller.snapshot();
        const surfaceRisk = classifySnapshotSurface(result);
        if (surfaceRisk.blocked) {
          return this.blocked(identity, surfaceRisk, {
            action: "snapshot",
          });
        }
        await this.audit.record({
          event: "browser.snapshot",
          principal: identity.principal,
          snapshotId: result.snapshotId,
          controlCount: result.controls.length,
          hintCount: result.hints.length,
          url: safeUrl(result.url),
        });
        return result;
      }

      case "browser.screenshot": {
        this.requireCapability(identity, CAPABILITIES.SCREENSHOT);
        this.requireNoHandoff();
        this.requireContributionPage();
        const result = await this.controller.screenshot();
        await this.audit.record({
          event: "browser.screenshot",
          principal: identity.principal,
          screenshotId: result.screenshotId,
          width: result.width,
          height: result.height,
          url: safeUrl(result.url),
        });
        return result;
      }

      case "browser.scroll": {
        this.requireCapability(identity, CAPABILITIES.SCROLL);
        this.requireNoHandoff();
        this.requireContributionPage();
        const direction = String(params.direction || "");
        const amount = String(params.amount || "page");
        if (!new Set(["up", "down"]).has(direction)) {
          throw new DaemonError(
            400,
            "invalid_scroll_direction",
            "Scroll direction must be up or down",
          );
        }
        if (!new Set(["small", "page", "bottom"]).has(amount)) {
          throw new DaemonError(
            400,
            "invalid_scroll_amount",
            "Scroll amount must be small, page or bottom",
          );
        }
        if (amount === "bottom" && direction !== "down") {
          throw new DaemonError(
            400,
            "invalid_scroll_combination",
            "Bottom scrolling is only valid in the down direction",
          );
        }
        return this.executor.run(async () => {
          const result = await this.controller.scroll({
            direction,
            amount,
            anchor: params.anchor,
          });
          await this.audit.record({
            event: "browser.scroll",
            principal: identity.principal,
            direction,
            amount,
            anchor: result.anchor,
            url: safeUrl(this.controller.status().url),
          });
          return result;
        });
      }

      case "browser.captureSeries": {
        this.requireCapability(identity, CAPABILITIES.CAPTURE_SERIES);
        this.requireNoHandoff();
        this.requireContributionPage();
        this.requireSunoStudioPage();
        const label =
          typeof params.label === "string" ? params.label.slice(0, 200) : "";
        const maxShots = Number(params.maxShots);
        const anchor =
          params.anchor && typeof params.anchor === "object"
            ? params.anchor
            : null;
        return this.executor.run(async () => {
          const result = await this.controller.captureSeries({
            label,
            anchor,
            maxShots: Number.isFinite(maxShots) ? maxShots : undefined,
          });
          await this.audit.record({
            event: "browser.captureSeries",
            principal: identity.principal,
            captureId: result.captureId,
            label: result.label,
            dirName: result.dirName,
            shotCount: result.shotCount,
            reachedEnd: result.reachedEnd,
            stopReason: result.stopReason,
            url: safeUrl(this.controller.status().url),
          });
          return result;
        });
      }

      case "browser.downloadStatus": {
        this.requireCapability(identity, CAPABILITIES.DOWNLOAD_STATUS);
        const result = this.controller.downloadStatus({
          downloadId:
            typeof params.downloadId === "string" ? params.downloadId : null,
          includeCompleted: Boolean(params.includeCompleted),
          principal: identity.principal,
        });
        await this.audit.record({
          event: "browser.downloadStatus",
          principal: identity.principal,
          url: safeUrl(this.controller.status().url),
        });
        return result;
      }

      case "browser.click": {
        this.requireCapability(identity, CAPABILITIES.CLICK);
        this.requireNoHandoff();
        this.requireContributionPage();
        const target = this.controller.resolveRef(params.ref);
        const risk = classifyAction({
          action: "click",
          node: target.node,
          url: this.controller.status().url,
        });
        if (risk.blocked) {
          const context = { action: "click", ref: params.ref };
          if (
            !risk.delegableCapability ||
            !identity.capabilities.includes(risk.delegableCapability)
          ) {
            return this.blocked(identity, risk, context);
          }
          await this.recordDelegatedAction(identity, risk, context);
        }
        return this.executor.run(async () => {
          let downloadPermit = null;
          if (risk.code === "studio_download_requires_finalize") {
            this.requireSunoStudioPage();
            downloadPermit = this.controller.armSunoDownload({
              principal: identity.principal,
            });
          }
          let result;
          try {
            result = await this.controller.clickRef(params.ref, {
              mouseButton: params.mouseButton || "left",
            });
          } catch (error) {
            if (downloadPermit) {
              this.controller.disarmSunoDownload(downloadPermit.permitId);
            }
            throw error;
          }
          await this.audit.record({
            event: "browser.click",
            principal: identity.principal,
            ref: params.ref,
            role: target.node.role,
            name: target.node.name,
            mouseButton: params.mouseButton || "left",
            url: safeUrl(this.controller.status().url),
          });
          return result;
        });
      }

      case "browser.clickVisual": {
        this.requireCapability(identity, CAPABILITIES.CLICK_VISUAL);
        this.requireNoHandoff();
        this.requireContributionPage();
        const target = await this.controller.resolveVisualPoint(params);
        const risk = classifyAction({
          action: "click",
          node: target.node,
          url: this.controller.status().url,
        });
        if (risk.blocked) {
          const context = {
            action: "clickVisual",
            ref: params.screenshotId,
          };
          if (
            !risk.delegableCapability ||
            !identity.capabilities.includes(risk.delegableCapability)
          ) {
            return this.blocked(identity, risk, context);
          }
          await this.recordDelegatedAction(identity, risk, context);
        }
        return this.executor.run(async () => {
          let downloadPermit = null;
          if (risk.code === "studio_download_requires_finalize") {
            this.requireSunoStudioPage();
            downloadPermit = this.controller.armSunoDownload({
              principal: identity.principal,
            });
          }
          let result;
          try {
            result = await this.controller.clickVisual(target.point, {
              mouseButton: params.mouseButton || "left",
            });
          } catch (error) {
            if (downloadPermit) {
              this.controller.disarmSunoDownload(downloadPermit.permitId);
            }
            throw error;
          }
          await this.audit.record({
            event: "browser.clickVisual",
            principal: identity.principal,
            screenshotId: params.screenshotId,
            role: target.node.role,
            name: target.node.name,
            mouseButton: params.mouseButton || "left",
            url: safeUrl(this.controller.status().url),
          });
          return result;
        });
      }

      case "browser.inspectXimalayaPublish": {
        this.requireCapability(identity, CAPABILITIES.SNAPSHOT);
        this.requireNoHandoff();
        this.requireContributionPage();
        const target = await this.controller.inspectXimalayaPublish();
        this.requireContributionPage(target.frameUrl);
        return { ready: true, name: target.node.name, frameUrl: target.frameUrl };
      }

      case "browser.clickXimalayaPublish": {
        this.requireCapability(identity, CAPABILITIES.CLICK);
        this.requireNoHandoff();
        this.requireContributionPage();
        return this.executor.run(async () => {
          this.requireNoHandoff();
          const target = await this.controller.inspectXimalayaPublish();
          this.requireContributionPage(target.frameUrl);
          const risk = classifyAction({
            action: "click", node: target.node, url: target.frameUrl,
          });
          if (!risk.blocked || risk.code !== "irreversible_action_requires_handoff") {
            throw new DaemonError(409, "publish_risk_mismatch", "Publish control could not be verified");
          }
          const context = { action: "clickXimalayaPublish", ref: "确认发布" };
          if (!risk.delegableCapability ||
              !identity.capabilities.includes(risk.delegableCapability)) {
            return this.blocked(identity, risk, context);
          }
          await this.recordDelegatedAction(identity, risk, context);
          const result = await this.controller.clickXimalayaPublish();
          await this.audit.record({
            event: "browser.clickXimalayaPublish",
            principal: identity.principal,
            name: target.node.name,
            frameUrl: target.frameUrl,
            url: safeUrl(this.controller.status().url),
          });
          return result;
        });
      }

      case "browser.fill": {
        this.requireCapability(identity, CAPABILITIES.FILL);
        this.requireNoHandoff();
        this.requireContributionPage();
        if (typeof params.value !== "string" || params.value.length > 100_000) {
          throw new DaemonError(400, "invalid_value", "Fill value is invalid or too large");
        }
        const target = this.controller.resolveRef(params.ref);
        const risk = classifyAction({
          action: "fill",
          node: target.node,
          url: this.controller.status().url,
        });
        if (risk.blocked) {
          return this.blocked(identity, risk, {
            action: "fill",
            ref: params.ref,
          });
        }
        return this.executor.run(async () => {
          const result = await this.controller.fillRef(params.ref, params.value);
          await this.audit.record({
            event: "browser.fill",
            principal: identity.principal,
            ref: params.ref,
            field:
              target.node.placeholder ||
              target.node.ariaLabel ||
              target.node.nameAttr ||
              target.node.role ||
              "field",
            value: params.value,
            url: safeUrl(this.controller.status().url),
          });
          return result;
        });
      }

      case "browser.fillVisual": {
        this.requireCapability(identity, CAPABILITIES.FILL);
        this.requireCapability(identity, CAPABILITIES.CLICK_VISUAL);
        this.requireNoHandoff();
        this.requireContributionPage();
        if (typeof params.value !== "string" || params.value.length > 100_000) {
          throw new DaemonError(400, "invalid_value", "Fill value is invalid or too large");
        }
        const target = await this.controller.resolveVisualPoint(params, {
          promoteEditable: true,
        });
        const currentUrl = new URL(this.controller.status().url);
        const verifiedXimalayaUploadEditor =
          currentUrl.origin === "https://studio.ximalaya.com" &&
          /^\/upload(?:Works)?\/?$/.test(currentUrl.pathname);
        const editable =
          target.node.contentEditable ||
          ["input", "textarea"].includes(target.node.tag) ||
          ["textbox", "searchbox", "combobox"].includes(target.node.role) ||
          verifiedXimalayaUploadEditor;
        if (!editable) {
          throw new DaemonError(
            409,
            "invalid_fill_target",
            "Visual fill point is not a verified editable control",
          );
        }
        const risk = classifyAction({
          action: "fill",
          node: target.node,
          url: this.controller.status().url,
        });
        if (risk.blocked) {
          return this.blocked(identity, risk, {
            action: "fillVisual",
            ref: params.screenshotId,
          });
        }
        return this.executor.run(async () => {
          const result = await this.controller.fillVisualPoint(
            target.point,
            params.value,
          );
          await this.audit.record({
            event: "browser.fillVisual",
            principal: identity.principal,
            screenshotId: params.screenshotId,
            field:
              target.node.placeholder ||
              target.node.ariaLabel ||
              target.node.nameAttr ||
              target.node.role ||
              "field",
            value: params.value,
            url: safeUrl(this.controller.status().url),
          });
          return result;
        });
      }

      case "browser.upload": {
        this.requireCapability(identity, CAPABILITIES.UPLOAD);
        this.requireNoHandoff();
        this.requireContributionPage();
        const inputFiles = Array.isArray(params.files) ? params.files : [];
        if (inputFiles.length < 1 || inputFiles.length > 8) {
          throw new DaemonError(400, "invalid_files", "Upload requires one to eight files");
        }
        const target = this.controller.resolveRef(params.ref);
        const risk = classifyAction({
          action: "upload",
          node: target.node,
          url: this.controller.status().url,
        });
        if (risk.blocked) {
          return this.blocked(identity, risk, {
            action: "upload",
            ref: params.ref,
          });
        }
        const checked = [];
        for (const file of inputFiles) {
          checked.push(
            await assertAllowedUploadPath(
              file,
              this.config.security.uploadRoots,
            ),
          );
        }
        return this.executor.run(async () => {
          const result = await this.controller.uploadRef(
            params.ref,
            checked.map((entry) => entry.filePath),
          );
          await this.audit.record({
            event: "browser.upload",
            principal: identity.principal,
            ref: params.ref,
            files: checked.map((entry) => ({
              name: path.basename(entry.filePath),
              size: entry.size,
            })),
            url: safeUrl(this.controller.status().url),
          });
          return result;
        });
      }

      case "browser.uploadVisual": {
        this.requireCapability(identity, CAPABILITIES.UPLOAD);
        this.requireCapability(identity, CAPABILITIES.CLICK_VISUAL);
        this.requireNoHandoff();
        this.requireContributionPage();
        const inputFiles = Array.isArray(params.files) ? params.files : [];
        if (inputFiles.length < 1 || inputFiles.length > 8) {
          throw new DaemonError(400, "invalid_files", "Upload requires one to eight files");
        }
        const target = await this.controller.resolveVisualPoint(params);
        const label = [
          target.node?.name,
          target.node?.ariaLabel,
          target.node?.title,
          target.node?.text,
        ]
          .filter(Boolean)
          .join(" ");
        if (!/upload|上传|选择.{0,8}文件|音频|视频/i.test(label)) {
          throw new DaemonError(
            409,
            "invalid_upload_target",
            "Visual upload point is not a visible upload control",
          );
        }
        const checked = [];
        for (const file of inputFiles) {
          checked.push(
            await assertAllowedUploadPath(file, this.config.security.uploadRoots),
          );
        }
        return this.executor.run(async () => {
          const result = await this.controller.uploadVisual(
            target.point,
            checked.map((entry) => entry.filePath),
          );
          await this.audit.record({
            event: "browser.uploadVisual",
            principal: identity.principal,
            screenshotId: params.screenshotId,
            files: checked.map((entry) => ({
              name: path.basename(entry.filePath),
              size: entry.size,
            })),
            url: safeUrl(this.controller.status().url),
          });
          return result;
        });
      }

      case "browser.handoff": {
        this.requireCapability(identity, CAPABILITIES.HANDOFF);
        const reason = String(params.reason || "需要用户接管").slice(0, 500);
        const result = this.controller.setHandoff(reason, {
          requestedBy: identity.principal,
        });
        await this.audit.record({
          event: "browser.handoff",
          principal: identity.principal,
          reason,
          url: safeUrl(this.controller.status().url),
        });
        return result;
      }

      default:
        throw new DaemonError(404, "method_not_found", `Unknown method: ${method}`);
    }
  }
}

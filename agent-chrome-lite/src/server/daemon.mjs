import path from "node:path";

import { assertAllowedDownloadPath, assertAllowedUploadPath } from "../config.mjs";
import { CAPABILITIES } from "../constants.mjs";
import { assertContributionUrl } from "../security/contribution-policy.mjs";
import { isPrivateNetworkHostname } from "../security/network-egress.mjs";
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
    this.lastControlledDownloadAt = 0;
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
        this.requireNoHandoff();
        this.requireContributionPage(params.url);
        return this.executor.run(async () => {
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

      case "browser.download": {
        this.requireCapability(identity, CAPABILITIES.DOWNLOAD_FILE);
        this.requireNoHandoff();
        let parsed;
        try {
          parsed = new URL(String(params.url || ""));
        } catch {
          throw new DaemonError(400, "invalid_download_url", "Download URL is invalid");
        }
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
          throw new DaemonError(
            400,
            "invalid_download_url",
            "Controlled downloads require a clean https URL",
          );
        }
        if (isPrivateNetworkHostname(parsed.hostname)) {
          throw new DaemonError(
            403,
            "download_source_not_allowed",
            "Controlled downloads never target loopback or private networks",
          );
        }
        const allowedOrigins = new Set(
          (this.config.security.downloadSources || []).map((s) => s.origin),
        );
        if (!allowedOrigins.has(parsed.origin)) {
          throw new DaemonError(
            403,
            "download_source_not_allowed",
            "URL origin is not in the daemon's local download source allowlist",
          );
        }
        const checked = await assertAllowedDownloadPath(
          String(params.savePath || ""),
          this.config.security.downloadRoots,
          { overwrite: Boolean(params.overwrite) },
        );
        // 单队列之外再强制逐条最小间隔（默认 1200ms，配置下限 1000ms），
        // 保证人类节奏，不允许贴脸连发。
        const minInterval = Math.max(
          1000,
          Number(this.config.security.downloadMinIntervalMs) || 1200,
        );
        const elapsed = Date.now() - this.lastControlledDownloadAt;
        if (this.lastControlledDownloadAt && elapsed < minInterval) {
          await new Promise((resolve) =>
            setTimeout(resolve, minInterval - elapsed),
          );
        }
        this.lastControlledDownloadAt = Date.now();
        return this.executor.run(async () => {
          const result = await this.controller.controlledDownload({
            url: parsed.href,
            savePath: checked.filePath,
            filename: checked.filename,
            principal: identity.principal,
          });
          await this.audit.record({
            event: "browser.download",
            principal: identity.principal,
            downloadId: result.downloadId,
            url: safeUrl(parsed.href),
            filename: checked.filename,
            overwrite: checked.overwrite,
            started: result.started,
          });
          if (!result.started) {
            throw new DaemonError(
              502,
              "download_not_started",
              "The browser session produced no download; the server may have refused the request. Hand off to the user if a human check is shown.",
              { downloadId: result.downloadId },
            );
          }
          return {
            downloadId: result.downloadId,
            state: result.state,
            savePath: result.savePath,
            filename: result.filename,
          };
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

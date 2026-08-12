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
          return this.blocked(identity, risk, {
            action: "click",
            ref: params.ref,
          });
        }
        return this.executor.run(async () => {
          const result = await this.controller.clickRef(params.ref);
          await this.audit.record({
            event: "browser.click",
            principal: identity.principal,
            ref: params.ref,
            role: target.node.role,
            name: target.node.name,
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
          return this.blocked(identity, risk, {
            action: "clickVisual",
            ref: params.screenshotId,
          });
        }
        return this.executor.run(async () => {
          const result = await this.controller.clickVisual(target.point);
          await this.audit.record({
            event: "browser.clickVisual",
            principal: identity.principal,
            screenshotId: params.screenshotId,
            role: target.node.role,
            name: target.node.name,
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

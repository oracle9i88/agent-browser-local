/**
 * 迁移向导（Chrome → Agent 登录态迁移）。
 *
 * 约束（Codex 硬约束 1/2/5/6/7）：
 * - 只有用户点击"开始同步"并通过 confirm 后才会调用 CDP 同步；
 * - 先展示平台域名列表，逐域勾选，默认全不选；
 * - 向导只展示计数与域名，永远不展示 Cookie 名称以外的细节，更没有 Cookie 值；
 * - 同步完成后逐平台提供"打开验证"，由用户人工确认登录态（人机验证/2FA 仍为人工）。
 */
(() => {
  "use strict";

  const bridge = window.agentBrowser;
  if (!bridge || typeof bridge.migrationRun !== "function") return;

  let offers = [];
  let panel = null;
  let status = null;
  let results = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text) {
    const node = el("button", className, text);
    node.type = "button";
    return node;
  }

  function selectedDomains() {
    return [...panel.querySelectorAll("input[data-migration-domain]:checked")].map(
      (input) => input.value,
    );
  }

  function setStatus(node, message, tone) {
    node.textContent = message || "";
    node.dataset.tone = tone || "info";
  }

  async function renderProfiles(container) {
    const section = el("div", "migration-profiles");
    section.append(el("div", "migration-section-title", "Chrome 配置"));
    try {
      const detected = await bridge.migrationDetect();
      if (!detected.available) {
        section.append(el("div", "migration-warning", "未找到本机 Chrome 用户数据目录。"));
        container.append(section);
        return;
      }
      for (const profile of detected.profiles) {
        const row = el("div", "migration-profile-row");
        const name = profile.userName
          ? `${profile.displayName}（${profile.userName}）`
          : profile.displayName;
        row.append(el("span", "migration-profile-name", name));
        if (detected.chromeRunning) {
          row.append(el("span", "migration-badge", "Chrome 运行中"));
        }
        section.append(row);
      }
      section.append(
        el(
          "div",
          "migration-hint",
          "同步以当前运行中的 Chrome 会话为准；请先在 Chrome 中打开并登录目标平台，再勾选对应域名。",
        ),
      );
    } catch (error) {
      section.append(el("div", "migration-warning", String(error?.message || error)));
    }
    container.append(section);
  }

  function renderOffers(container) {
    const section = el("div", "migration-offers");
    section.append(el("div", "migration-section-title", "平台域名（逐域勾选，默认全不选）"));
    for (const offer of offers) {
      const card = el("div", "migration-offer");
      card.append(el("div", "migration-offer-label", offer.label));
      for (const domain of offer.domains) {
        const label = el("label", "migration-domain");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = domain;
        input.dataset.migrationDomain = "1";
        input.addEventListener("change", () => syncStartButton());
        label.append(input, el("span", undefined, domain));
        card.append(label);
      }
      section.append(card);
    }
    container.append(section);
  }

  function renderResults(container, result) {
    const section = el("div", "migration-results");
    section.append(el("div", "migration-section-title", "同步结果"));
    for (const platform of result.platforms) {
      const row = el("div", "migration-result-row");
      row.append(
        el("span", undefined, `${platform.label}：已注入 ${platform.injectedCount} 项会话 Cookie`),
      );
      const verify = button("migration-verify", "打开验证");
      verify.addEventListener("click", () => {
        bridge.navigate(platform.startUrl);
      });
      row.append(verify);
      section.append(row);
    }
    section.append(
      el(
        "div",
        "migration-hint",
        "请逐平台打开并人工确认登录态；遇到人机验证、2FA、发布或支付环节时，始终由你本人完成。",
      ),
    );
    container.append(section);
  }

  function syncStartButton() {
    const start = panel?.querySelector("#migration-start");
    if (start) start.disabled = selectedDomains().length === 0;
  }

  async function startSync(statusNode, resultsContainer) {
    const domains = selectedDomains();
    if (domains.length === 0) return;
    const confirmed = window.confirm(
      `将把勾选的 ${domains.length} 个域名的会话 Cookie 从 Chrome 同步到 Agent Space。\n` +
        "CDP 按 URL 范围读取；白名单外名称的 Cookie 会被立即过滤丢弃。\n" +
        "授权 Cookie 明文只在本地主进程内存中短暂处理，不保存、不上传、不展示。\n继续同步？",
    );
    if (!confirmed) return;
    setStatus(statusNode, "正在同步…", "info");
    try {
      const result = await bridge.migrationRun(domains);
      setStatus(statusNode, "同步完成。", "ok");
      resultsContainer.replaceChildren();
      renderResults(resultsContainer, result);
    } catch (error) {
      setStatus(statusNode, String(error?.message || error), "error");
    }
  }

  async function rollback(statusNode) {
    if (!window.confirm("将按迁移记录移除最近一次同步注入的会话 Cookie。继续？")) return;
    try {
      const result = await bridge.migrationRollback();
      setStatus(statusNode, `已回滚 ${result.id}：移除 ${result.removedCount} 项。`, "ok");
    } catch (error) {
      setStatus(statusNode, String(error?.message || error), "error");
    }
  }

  async function buildPanel() {
    panel = el("div", "migration-panel");
    panel.id = "migration-panel";
    panel.hidden = true;

    const header = el("div", "migration-header");
    header.append(el("div", "migration-title", "迁移登录态（Chrome → Agent）"));
    const close = button("migration-close", "×");
    close.setAttribute("aria-label", "关闭迁移向导");
    close.addEventListener("click", () => {
      panel.hidden = true;
    });
    header.append(close);
    panel.append(header);

    panel.append(
      el(
        "div",
        "migration-hint",
        "只同步你在下方明确勾选域名的会话 Cookie；Google 身份域永远禁止导入。" +
          "CDP 按 URL 范围读取，白名单外名称的 Cookie 会在主进程内存中被立即过滤丢弃；" +
          "授权 Cookie 明文只在本地主进程内存中短暂处理，不保存、不上传、不展示。" +
          "Agent 不会自行决定域名或权限。",
      ),
    );

    const profilesContainer = el("div");
    panel.append(profilesContainer);

    const offersContainer = el("div", "migration-offers");
    offersContainer.append(el("div", "migration-section-title", "平台域名（逐域勾选，默认全不选）"));
    panel.append(offersContainer);
    panel.append(actionsEl());
    panel.append(statusEl());
    panel.append(resultsContainerEl());

    panel.insertBefore(profilesContainer, offersContainer);
    renderProfiles(profilesContainer);
    await renderOfferList(offersContainer);

    document.body.append(panel);
  }

  function actionsEl() {
    const actions = el("div", "migration-actions");
    const start = button("migration-start", "开始同步");
    start.id = "migration-start";
    start.disabled = true;
    start.addEventListener("click", () => startSync(status, results));
    actions.append(start);
    const rollbackButton = button("migration-rollback", "回滚最近一次迁移");
    rollbackButton.addEventListener("click", () => rollback(status));
    actions.append(rollbackButton);
    return actions;
  }

  function statusEl() {
    status = el("div", "migration-status");
    return status;
  }

  function resultsContainerEl() {
    results = el("div");
    return results;
  }

  async function renderOfferList(container) {
    try {
      offers = await bridge.migrationOffers();
    } catch (error) {
      container.append(
        el("div", "migration-warning", `平台列表加载失败：${String(error?.message || error)}`),
      );
      return;
    }
    renderOffers(container);
  }

  function buildToggleButton() {
    const toggle = button("migration-toggle", "迁移登录态");
    toggle.id = "migration-toggle";
    toggle.addEventListener("click", () => {
      if (!panel) buildPanel();
      panel.hidden = !panel.hidden;
    });
    const toolbar = document.querySelector(".toolbar");
    const handoff = document.getElementById("handoff");
    if (toolbar && handoff) {
      toolbar.insertBefore(toggle, handoff);
    } else if (toolbar) {
      toolbar.append(toggle);
    } else {
      document.body.append(toggle);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildToggleButton);
  } else {
    buildToggleButton();
  }
})();

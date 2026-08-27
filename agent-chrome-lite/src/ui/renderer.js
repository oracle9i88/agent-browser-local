const address = document.querySelector("#address");
const addressForm = document.querySelector("#address-form");
const back = document.querySelector("#back");
const forward = document.querySelector("#forward");
const reload = document.querySelector("#reload");
const handoff = document.querySelector("#handoff");
const externalAuth = document.querySelector("#external-auth");
const externalAuthSync = document.querySelector("#external-auth-sync");
const recovery = document.querySelector("#recovery");
const agentState = document.querySelector("#agent-state");
const securityDot = document.querySelector("#security-dot");

function render(state) {
  if (document.activeElement !== address) address.value = state.url || "";
  back.disabled = !state.canGoBack;
  forward.disabled = !state.canGoForward;
  reload.textContent = state.loading ? "×" : "↻";
  securityDot.dataset.secure = String((state.url || "").startsWith("https://"));
  const externalAuthPending =
    state.handoff?.required &&
    state.handoff.detail?.code === "external_auth_required";
  const externalAuthSynced =
    state.handoff?.required &&
    state.handoff.detail?.code === "external_auth_synced";
  if (state.pageHealth?.state === "faulted") {
    agentState.textContent = "页面故障：登录资料已保留，等待人工恢复";
    agentState.classList.add("page-fault");
    agentState.classList.remove("needs-handoff");
    recovery.hidden = false;
    externalAuth.hidden = true;
    externalAuthSync.hidden = true;
    handoff.hidden = true;
  } else if (externalAuthPending) {
    const provider = state.handoff.detail?.provider === "google" ? "Google" : "Suno";
    agentState.textContent = `已转到 Chrome：请完成 ${provider} 登录`;
    agentState.classList.add("needs-handoff");
    agentState.classList.remove("page-fault");
    recovery.hidden = true;
    externalAuth.hidden = false;
    externalAuth.disabled = false;
    externalAuth.textContent = `在 Chrome 中打开 ${provider} 登录`;
    externalAuthSync.hidden = false;
    externalAuthSync.disabled = false;
    externalAuthSync.textContent = "完成后同步认证";
    // A Chrome session is intentionally not copied into Electron. Do not
    // offer the generic clear button here, or an accidental click would make
    // agents resume against an unauthenticated Electron profile.
    handoff.hidden = true;
  } else if (externalAuthSynced) {
    agentState.textContent = "认证资料已同步：请确认 Suno 已登录";
    agentState.classList.add("needs-handoff");
    agentState.classList.remove("page-fault");
    recovery.hidden = false;
    externalAuth.hidden = true;
    externalAuthSync.hidden = true;
    handoff.hidden = false;
    handoff.disabled = false;
    handoff.textContent = "我已接管";
  } else if (state.handoff?.required) {
    agentState.textContent = `需要你接管：${state.handoff.reason}`;
    agentState.classList.add("needs-handoff");
    agentState.classList.remove("page-fault");
    recovery.hidden = true;
    externalAuth.hidden = true;
    externalAuthSync.hidden = true;
    handoff.hidden = false;
    handoff.disabled = false;
    handoff.textContent = "我已接管";
  } else if (!state.daemon?.ready) {
    agentState.textContent = "本地 daemon 启动中";
    agentState.classList.remove("needs-handoff", "page-fault");
    recovery.hidden = true;
    externalAuth.hidden = true;
    externalAuthSync.hidden = true;
    handoff.hidden = false;
    handoff.disabled = true;
    handoff.textContent = "Agent 未就绪";
  } else {
    agentState.textContent = `本地安全模式 · v${state.version}`;
    agentState.classList.remove("needs-handoff");
    agentState.classList.remove("page-fault");
    recovery.hidden = true;
    externalAuth.hidden = true;
    externalAuthSync.hidden = true;
    handoff.hidden = false;
    handoff.disabled = true;
    handoff.textContent = "Agent 可操作";
  }
}

addressForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await window.agentBrowser.navigate(address.value);
});
back.addEventListener("click", () => window.agentBrowser.back());
forward.addEventListener("click", () => window.agentBrowser.forward());
reload.addEventListener("click", () => window.agentBrowser.reload());
recovery.addEventListener("click", () => window.agentBrowser.recover());
externalAuth.addEventListener("click", async () => {
  externalAuth.disabled = true;
  try {
    await window.agentBrowser.openExternalAuth();
  } finally {
    externalAuth.disabled = false;
  }
});
externalAuthSync.addEventListener("click", async () => {
  externalAuthSync.disabled = true;
  try {
    await window.agentBrowser.syncExternalAuth();
  } catch (error) {
    agentState.textContent = `同步失败：${String(error?.message || error).slice(0, 160)}`;
  } finally {
    externalAuthSync.disabled = false;
  }
});
handoff.addEventListener("click", () => window.agentBrowser.clearHandoff());

window.agentBrowser.onState(render);
window.agentBrowser.status().then(render);

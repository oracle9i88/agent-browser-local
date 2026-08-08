const address = document.querySelector("#address");
const addressForm = document.querySelector("#address-form");
const back = document.querySelector("#back");
const forward = document.querySelector("#forward");
const reload = document.querySelector("#reload");
const handoff = document.querySelector("#handoff");
const recovery = document.querySelector("#recovery");
const agentState = document.querySelector("#agent-state");
const securityDot = document.querySelector("#security-dot");

function render(state) {
  if (document.activeElement !== address) address.value = state.url || "";
  back.disabled = !state.canGoBack;
  forward.disabled = !state.canGoForward;
  reload.textContent = state.loading ? "×" : "↻";
  securityDot.dataset.secure = String((state.url || "").startsWith("https://"));
  if (state.pageHealth?.state === "faulted") {
    agentState.textContent = "页面故障：登录资料已保留，等待人工恢复";
    agentState.classList.add("page-fault");
    agentState.classList.remove("needs-handoff");
    recovery.hidden = false;
    handoff.hidden = true;
  } else if (state.handoff?.required) {
    agentState.textContent = `需要你接管：${state.handoff.reason}`;
    agentState.classList.add("needs-handoff");
    agentState.classList.remove("page-fault");
    recovery.hidden = true;
    handoff.hidden = false;
  } else if (!state.daemon?.ready) {
    agentState.textContent = "本地 daemon 启动中";
    agentState.classList.remove("needs-handoff", "page-fault");
    recovery.hidden = true;
    handoff.hidden = true;
  } else {
    agentState.textContent = `本地安全模式 · v${state.version}`;
    agentState.classList.remove("needs-handoff");
    agentState.classList.remove("page-fault");
    recovery.hidden = true;
    handoff.hidden = true;
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
handoff.addEventListener("click", () => window.agentBrowser.clearHandoff());

window.agentBrowser.onState(render);
window.agentBrowser.status().then(render);

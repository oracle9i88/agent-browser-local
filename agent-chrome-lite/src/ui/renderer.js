const address = document.querySelector("#address");
const addressForm = document.querySelector("#address-form");
const back = document.querySelector("#back");
const forward = document.querySelector("#forward");
const reload = document.querySelector("#reload");
const handoff = document.querySelector("#handoff");
const agentState = document.querySelector("#agent-state");
const securityDot = document.querySelector("#security-dot");

function render(state) {
  if (document.activeElement !== address) address.value = state.url || "";
  back.disabled = !state.canGoBack;
  forward.disabled = !state.canGoForward;
  reload.textContent = state.loading ? "×" : "↻";
  securityDot.dataset.secure = String((state.url || "").startsWith("https://"));
  if (state.handoff?.required) {
    agentState.textContent = `需要你接管：${state.handoff.reason}`;
    agentState.classList.add("needs-handoff");
    handoff.hidden = false;
  } else {
    agentState.textContent = "本地安全模式";
    agentState.classList.remove("needs-handoff");
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
handoff.addEventListener("click", () => window.agentBrowser.clearHandoff());

window.agentBrowser.onState(render);
window.agentBrowser.status().then(render);


const DEFAULT_ENDPOINT = "http://127.0.0.1:8765/api/evaluate";
const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;
const MAX_GOAL_LENGTH = 2_000;
const MAX_STATE_TEXT = 24_000;
const MAX_CANDIDATE_TEXT = 1_000;

const REVIEW_ACTION = /publish|post|submit|send|delete|remove|pay|purchase|confirm|发表|发布|提交|发送|删除|支付|购买|确认/i;

export function requiresNanoJevReview(control) {
  if (!control || typeof control !== "object") return false;
  return REVIEW_ACTION.test([
    control.role,
    control.name,
    control.ariaLabel,
    control.title,
    control.formAction,
  ].filter(Boolean).join(" "));
}

function text(value, max = MAX_CANDIDATE_TEXT) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function assertGoal(goal) {
  if (typeof goal !== "string" || !goal.trim()) {
    throw new Error("NanoJev goal must be a non-empty string");
  }
  if (goal.length > MAX_GOAL_LENGTH) {
    throw new Error(`NanoJev goal must be at most ${MAX_GOAL_LENGTH} characters`);
  }
}

function controlDescription(control) {
  const parts = [
    control.role && `role=${text(control.role, 80)}`,
    control.name && `name=${text(control.name)}`,
    control.placeholder && `placeholder=${text(control.placeholder)}`,
    control.type && `type=${text(control.type, 80)}`,
    control.disabled ? "disabled=true" : "disabled=false",
    control.checked === true ? "checked=true" : control.checked === false ? "checked=false" : "",
    control.value ? `value=${text(control.value, 280)}` : "value=empty",
  ].filter(Boolean);
  return parts.join("; ").slice(0, MAX_CANDIDATE_TEXT);
}

export function snapshotToNanoJevState(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("A browser snapshot object is required");
  }
  const controls = Array.isArray(snapshot.controls) ? snapshot.controls : [];
  const hints = Array.isArray(snapshot.hints) ? snapshot.hints : [];
  return {
    url: text(snapshot.url, 2_000),
    title: text(snapshot.title, 500),
    snapshotId: text(snapshot.snapshotId, 100),
    controls: controls.map((control) => ({
      ref: text(control.ref, 100),
      description: controlDescription(control),
    })),
    hints: hints.map((hint) => ({
      role: text(hint.role, 80),
      text: text(hint.text, 500),
    })),
  };
}

export function buildNanoJevRequest({ goal, snapshot, questionId = "action" } = {}) {
  assertGoal(goal);
  if (typeof questionId !== "string" || !questionId.trim()) {
    throw new Error("NanoJev questionId must be a non-empty string");
  }

  const state = snapshotToNanoJevState(snapshot);
  if (state.controls.length < 2) {
    throw new Error("NanoJev needs at least two current snapshot controls");
  }
  if (state.controls.length > 255) {
    throw new Error("NanoJev supports at most 255 current snapshot controls");
  }

  const criteria = Object.fromEntries(
    state.controls.map(({ ref, description }) => [ref, description || `element ${ref}`]),
  );
  const stateForModel = JSON.stringify({
    goal: goal.trim(),
    url: state.url,
    title: state.title,
    controls: state.controls,
    hints: state.hints,
  });

  return {
    states: [{
      id: state.snapshotId || "browser-snapshot",
      state: stateForModel.slice(0, MAX_STATE_TEXT),
      questions: {
        [questionId]: {
          type: "choice",
          instructions: `Choose the single current browser element that best advances this goal: ${goal.trim()}`,
          criteria,
        },
      },
    }],
  };
}

function probabilityMap(answer) {
  if (!answer || typeof answer !== "object" || !answer.probabilities || typeof answer.probabilities !== "object") {
    throw new Error("NanoJev response is missing an action probability distribution");
  }
  return Object.fromEntries(
    Object.entries(answer.probabilities).map(([key, value]) => [key, Number(value)]),
  );
}

export function extractNanoJevDecision(payload, { questionId = "action", confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD } = {}) {
  const answer = payload?.states?.[0]?.answers?.[questionId];
  if (!answer || typeof answer !== "object") {
    throw new Error(`NanoJev response is missing states[0].answers.${questionId}`);
  }
  const probabilities = probabilityMap(answer);
  const entries = Object.entries(probabilities).filter(([, value]) => Number.isFinite(value) && value >= 0);
  if (entries.length === 0) throw new Error("NanoJev returned no finite action probabilities");
  entries.sort((left, right) => right[1] - left[1]);
  const [ref, confidence] = entries[0];
  if (typeof confidenceThreshold !== "number" || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error("NanoJev confidenceThreshold must be between 0 and 1");
  }
  return {
    ref,
    confidence,
    probabilities,
    ready: confidence >= confidenceThreshold,
    requiresReview: false,
    questionId,
  };
}

export async function evaluateNanoJev({ endpoint = process.env.NANOJEV_URL || DEFAULT_ENDPOINT, request, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!endpoint || typeof endpoint !== "string") throw new Error("NanoJev endpoint is required");
  if (!request || typeof request !== "object") throw new Error("NanoJev request is required");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok || payload?.error) {
      throw new Error(`NanoJev request failed (${response.status}): ${payload?.error || "unknown error"}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export const NANOJEV_DEFAULT_ENDPOINT = DEFAULT_ENDPOINT;

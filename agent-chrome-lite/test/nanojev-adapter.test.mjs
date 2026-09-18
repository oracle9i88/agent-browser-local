import test from "node:test";
import assert from "node:assert/strict";

import {
  buildNanoJevRequest,
  evaluateNanoJev,
  extractNanoJevDecision,
  requiresNanoJevReview,
  snapshotToNanoJevState,
} from "../src/nanojev/adapter.mjs";

const snapshot = {
  snapshotId: "abc123",
  title: "Article editor",
  url: "https://example.test/editor",
  controls: [
    { ref: "abc123:1", role: "textbox", name: "Title", placeholder: "Title", value: "" },
    { ref: "abc123:2", role: "textbox", name: "Body", contentEditable: true, value: "Draft" },
    { ref: "abc123:3", role: "button", name: "Save draft" },
  ],
  hints: [{ role: "heading", text: "Create article" }],
};

test("snapshotToNanoJevState keeps refs and compact semantic control descriptions", () => {
  const state = snapshotToNanoJevState(snapshot);
  assert.equal(state.snapshotId, "abc123");
  assert.equal(state.controls[2].ref, "abc123:3");
  assert.match(state.controls[0].description, /role=textbox/);
  assert.match(state.controls[0].description, /name=Title/);
});

test("buildNanoJevRequest emits NanoJev's strict choice schema", () => {
  const request = buildNanoJevRequest({ goal: "Save the article as a draft", snapshot });
  assert.deepEqual(Object.keys(request), ["states"]);
  assert.equal(request.states[0].id, "abc123");
  assert.equal(request.states[0].questions.action.type, "choice");
  assert.equal(Object.keys(request.states[0].questions.action.criteria).length, 3);
});

test("extractNanoJevDecision returns the top ref and review metadata", () => {
  const decision = extractNanoJevDecision({
    states: [{
      id: "abc123",
      answers: {
        action: {
          type: "choice",
          probabilities: {
            "abc123:1": 0.01,
            "abc123:2": 0.03,
            "abc123:3": 0.96,
          },
          choice: "abc123:3",
          value: "abc123:3",
        },
      },
    }],
  });
  assert.equal(decision.ref, "abc123:3");
  assert.equal(decision.ready, true);
  assert.equal(decision.requiresReview, false);
  assert.equal(requiresNanoJevReview({ role: "button", name: "Publish" }), true);
});

test("extractNanoJevDecision accepts the documented answers object shape", () => {
  const decision = extractNanoJevDecision({
    states: [{
      answers: {
        action: { probabilities: { publish: 0.91, draft: 0.09 } },
      },
    }],
  });
  assert.equal(decision.ref, "publish");
  assert.equal(requiresNanoJevReview({ role: "button", name: "Publish" }), true);
});

test("evaluateNanoJev posts JSON and returns the model payload", async () => {
  let seen;
  const payload = { states: [{ id: "abc123", answers: { action: { probabilities: {} } } }] };
  const result = await evaluateNanoJev({
    endpoint: "http://127.0.0.1:8765/api/evaluate",
    request: { states: [] },
    fetchImpl: async (_url, options) => {
      seen = { url: _url, options };
      return { ok: true, status: 200, json: async () => payload };
    },
  });
  assert.equal(seen.url, "http://127.0.0.1:8765/api/evaluate");
  assert.equal(seen.options.method, "POST");
  assert.deepEqual(JSON.parse(seen.options.body), { states: [] });
  assert.deepEqual(result, payload);
});

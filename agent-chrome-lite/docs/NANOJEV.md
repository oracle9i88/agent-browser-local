# NanoJev decision adapter

Agent Browser Local can ask a local NanoJev server to rank the controls in a
fresh browser Snapshot. The adapter is deliberately proposal-only: it never
executes the selected ref. Existing daemon capability checks, stale-ref checks,
risk policy, handoff rules, and audit logging remain the only execution path.

## Start NanoJev

Run NanoJev's persistent server separately with a local checkpoint:

```bash
python scripts/serve_decisions.py \
  --checkpoint-dir /path/to/NanoJev/checkpoint \
  --web-root web \
  --host 127.0.0.1 \
  --port 8765
```

The adapter uses `http://127.0.0.1:8765/api/evaluate` by default. Set
`NANOJEV_URL` to use another loopback endpoint.

## Ask for a proposal

With Agent Browser Local running and the MCP server configured:

```text
browser_nanojev_decide(
  goal="Save the current article as a draft",
  confidenceThreshold=0.85
)
```

The tool takes a fresh Snapshot, converts each current control into a dynamic
NanoJev Choice candidate, and returns:

```json
{
  "decision": {
    "ref": "<fresh-ref>",
    "confidence": 0.91,
    "ready": true,
    "requiresReview": false,
    "probabilities": {}
  },
  "selectedControl": {},
  "execution": "proposal_only"
}
```

The returned ref is valid only for that Snapshot. Take another Snapshot after
any action or navigation before using it. A candidate whose name looks like a
publish, submit, delete, payment, or confirmation action is marked
`requiresReview`; this is an advisory signal. The daemon's existing risk policy
and user handoff remain authoritative.

## Execute one bounded action

When the decision is ready, `browser_nanojev_act` can execute one operation
through the normal daemon API:

```text
browser_nanojev_act(
  goal="Fill the article title",
  operation="fill",
  value="AI 英语学习的三个误区",
  confidenceThreshold=0.85
)
```

The tool always takes a fresh Snapshot and refuses to execute below the
confidence threshold. The daemon still performs ref freshness, capability,
contribution-scope, credential, upload, and risk checks. A publish action can
only proceed when the local principal has the existing `browser.finalize.ref`
capability; otherwise the user handoff is returned. This makes the execution
boundary configurable per local principal without weakening the default policy.

## Why this is an adapter, not an autonomous loop

The public NanoJev checkpoints are trained for toy navigation and game
decisions. This integration provides the browser-side contract and a safe
proposal surface while domain data is collected. A future self-media model can
be fine-tuned on the JSONL audit traces without changing the browser execution
boundary.

The adapter sends only the bounded Snapshot fields already exposed by the
browser: URL, title, current controls, control semantics, values truncated to a
small limit, and contribution hints. It does not expose arbitrary page
JavaScript, selectors, or HTML export.

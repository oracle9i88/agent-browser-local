import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyPageRequest,
  isPrivateNetworkHostname,
} from "../src/security/network-egress.mjs";

const config = {
  security: {
    contributionTargets: [
      { origin: "https://studio.example.test", pathPrefixes: ["/upload"] },
    ],
  },
};

test("untrusted pages cannot probe loopback or private networks", () => {
  for (const hostname of [
    "localhost",
    "api.localhost",
    "127.0.0.1",
    "10.2.3.4",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.2",
    "169.254.2.3",
    "::1",
    "::ffff:7f00:1",
    "fd00::1",
    "fe80::1",
    "printer.local",
    "service.internal",
  ]) {
    assert.equal(isPrivateNetworkHostname(hostname), true, hostname);
  }
  assert.equal(isPrivateNetworkHostname("172.32.0.1"), false);
  assert.equal(isPrivateNetworkHostname("example.com"), false);
  assert.equal(isPrivateNetworkHostname("fcloud.example.com"), false);

  const decision = classifyPageRequest(
    {
      url: "http://127.0.0.1:3767/v1/session",
      resourceType: "xhr",
    },
    config,
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "private_network_blocked");
});

test("remote contribution resources pass through one policy decision", () => {
  assert.deepEqual(
    classifyPageRequest(
      {
        url: "https://cdn.example.net/editor.js",
        resourceType: "script",
      },
      config,
    ),
    { allowed: true },
  );
  assert.deepEqual(
    classifyPageRequest(
      {
        url: "https://studio.example.test/upload/new",
        resourceType: "mainFrame",
      },
      config,
    ),
    { allowed: true },
  );
});

test("external main-frame navigation is allowed only with immediate handoff", () => {
  const decision = classifyPageRequest(
    {
      url: "https://passport.example.test/login",
      resourceType: "mainFrame",
    },
    config,
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresHandoff, true);
  assert.equal(decision.code, "outside_contribution_scope");
});

test("unsafe schemes and embedded URL credentials are blocked", () => {
  assert.equal(
    classifyPageRequest(
      { url: "file:///Users/example/.ssh/config", resourceType: "subFrame" },
      config,
    ).code,
    "unsafe_outbound_scheme",
  );
  assert.equal(
    classifyPageRequest(
      { url: "https://user:secret@example.com/", resourceType: "xhr" },
      config,
    ).code,
    "embedded_credentials_blocked",
  );
});

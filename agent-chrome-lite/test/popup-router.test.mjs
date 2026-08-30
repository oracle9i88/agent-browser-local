import test from "node:test";
import assert from "node:assert/strict";

import { ContributionPopupRouter } from "../src/browser/popup-router.mjs";

const config = {
  security: {
    contributionTargets: [
      {
        origin: "https://mp.weixin.qq.com",
        pathPrefixes: ["/cgi-bin/appmsg"],
        requiredSearchParams: {
          action: ["edit"],
          t: ["media/appmsg_edit_v2"],
        },
      },
    ],
  },
};

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("routes a token-bearing contribution popup into the controlled main page", async () => {
  const navigated = [];
  let closed = 0;
  let routed = 0;
  const router = new ContributionPopupRouter(config, {
    navigate: async (url) => navigated.push(url),
    onRouted: () => {
      routed += 1;
    },
  });
  const editorUrl =
    "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&t=media/appmsg_edit_v2&token=session-context";

  assert.equal(
    router.route(editorUrl, {
      close: () => {
        closed += 1;
      },
    }),
    true,
  );
  await settle();

  assert.deepEqual(navigated, [editorUrl]);
  assert.equal(closed, 1);
  assert.equal(routed, 1);
});

test("never routes a management list or external popup", async () => {
  const navigated = [];
  const router = new ContributionPopupRouter(config, {
    navigate: async (url) => navigated.push(url),
  });

  assert.equal(
    router.route(
      "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&t=media/appmsg_list&token=session-context",
    ),
    false,
  );
  assert.equal(router.route("https://example.com/editor"), false);
  await settle();
  assert.deepEqual(navigated, []);
});

test("coalesces duplicate popup events without duplicating navigation", async () => {
  const navigated = [];
  const router = new ContributionPopupRouter(config, {
    navigate: async (url) => navigated.push(url),
  });
  const editorUrl =
    "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&t=media/appmsg_edit_v2&token=session-context";

  assert.equal(router.route(editorUrl), true);
  assert.equal(router.route(editorUrl), true);
  await settle();
  assert.deepEqual(navigated, [editorUrl]);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  contributionTargetsFor,
  DEFAULT_PLATFORM_IDS,
  HUMAN_ONLY_ACTIONS,
  mergeContributionTargets,
  PLATFORM_BACKLOG,
  removeContributionTargets,
} from "../src/security/platform-registry.mjs";

test("ximalaya registry exposes only verified contribution entry paths", () => {
  assert.deepEqual(contributionTargetsFor(["ximalaya"]), [
    {
      platform: "ximalaya",
      origin: "https://www.ximalaya.com",
      pathPrefixes: ["/reform-upload"],
    },
    {
      platform: "ximalaya",
      origin: "https://studio.ximalaya.com",
      pathPrefixes: ["/upload"],
    },
  ]);
});

test("wechat channels registry exposes the create surface, not the post list", () => {
  assert.deepEqual(contributionTargetsFor(["wechat_channels"]), [
    {
      platform: "wechat_channels",
      origin: "https://channels.weixin.qq.com",
      pathPrefixes: ["/platform/post/create"],
    },
  ]);
});

test("wechat official registry distinguishes editor from list by query", () => {
  assert.deepEqual(contributionTargetsFor(["wechat_official"]), [
    {
      platform: "wechat_official",
      origin: "https://mp.weixin.qq.com",
      pathPrefixes: ["/cgi-bin/appmsg"],
      requiredSearchParams: {
        action: ["edit"],
        t: ["media/appmsg_edit", "media/appmsg_edit_v2"],
      },
    },
  ]);
});

test("platform registration is additive and idempotent", () => {
  const existing = [
    {
      platform: "xiaoyuzhou",
      origin: "https://podcaster.xiaoyuzhoufm.com",
      pathPrefixes: ["/"],
    },
  ];
  const once = mergeContributionTargets(existing, ["ximalaya"]);
  const twice = mergeContributionTargets(once, ["ximalaya"]);
  assert.deepEqual(twice, once);
  assert.equal(once.length, 3);
});

test("platform registration narrows a legacy origin-wide target", () => {
  const legacy = [
    {
      origin: "https://creator.douyin.com",
      pathPrefixes: ["/"],
    },
  ];
  assert.deepEqual(mergeContributionTargets(legacy, ["douyin"]), [
    {
      platform: "douyin",
      origin: "https://creator.douyin.com",
      pathPrefixes: [
        "/creator-micro/content/upload",
        "/creator-micro/content/post/video",
        "/creator-micro/content/post/image",
      ],
    },
  ]);
});

test("suno stays defined but disabled by default and can be removed locally", () => {
  assert.equal(DEFAULT_PLATFORM_IDS.includes("suno"), false);
  const targets = [
    ...contributionTargetsFor(["xiaoyuzhou"]),
    ...contributionTargetsFor(["suno"]),
  ];
  assert.deepEqual(
    removeContributionTargets(targets, ["suno"]),
    contributionTargetsFor(["xiaoyuzhou"]),
  );
});

test("netease cloud music is recorded without touching the active publisher", () => {
  assert.equal(DEFAULT_PLATFORM_IDS.includes("netease_cloud_music"), false);
  assert.equal(
    PLATFORM_BACKLOG.netease_cloud_music.status,
    "awaiting_active_publisher_handoff",
  );
  assert.throws(
    () => contributionTargetsFor(["netease_cloud_music"]),
    /Unknown platform/,
  );
});

test("registry documents actions that no agent may perform", () => {
  assert.deepEqual(HUMAN_ONLY_ACTIONS, [
    "login-or-verification",
    "legal-consent",
    "create-or-publish",
    "delete",
    "payment",
  ]);
});

test("unknown platform ids are rejected", () => {
  assert.throws(
    () => contributionTargetsFor(["not-a-platform"]),
    /Unknown platform/,
  );
});

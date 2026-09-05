import test from "node:test";
import assert from "node:assert/strict";

import { isContributionUrlAllowed } from "../src/security/contribution-policy.mjs";

const config = {
  security: {
    contributionTargets: [
      {
        origin: "https://suno.com",
        pathPrefixes: ["/create", "/studio", "/studio-welcome", "/song/"],
      },
      {
        origin: "https://podcaster.xiaoyuzhoufm.com",
        pathTemplates: [
          "/podcast/:podcastId",
          "/podcast/:podcastId/episode/create",
        ],
        excludedTemplateValues: {
          podcastId: ["create", "new"],
        },
      },
      {
        origin: "https://www.ximalaya.com",
        pathPrefixes: ["/reform-upload"],
      },
      {
        origin: "https://studio.ximalaya.com",
        pathPrefixes: ["/upload", "/uploadWorks"],
      },
      {
        origin: "https://channels.weixin.qq.com",
        pathPrefixes: ["/platform/post/create"],
      },
      {
        origin: "https://creator.douyin.com",
        pathPrefixes: ["/creator-micro/content/upload"],
      },
      {
        origin: "https://creator.xiaohongshu.com",
        pathPrefixes: ["/publish/publish"],
      },
      {
        origin: "https://cp.kuaishou.com",
        pathPrefixes: ["/article/publish/video"],
      },
      {
        origin: "https://mp.weixin.qq.com",
        pathPrefixes: ["/cgi-bin/appmsg"],
        requiredSearchParams: {
          action: ["edit"],
          t: ["media/appmsg_edit", "media/appmsg_edit_v2"],
        },
      },
    ],
  },
};

test("allows only configured contribution surfaces", () => {
  assert.equal(isContributionUrlAllowed(config, "https://suno.com/create"), true);
  assert.equal(isContributionUrlAllowed(config, "https://suno.com/studio-welcome"), true);
  assert.equal(
    isContributionUrlAllowed(config, "https://studio.ximalaya.com/uploadWorks"),
    true,
  );
  assert.equal(
    isContributionUrlAllowed(config, "https://studio.ximalaya.com/upload"),
    true,
  );
  assert.equal(
    isContributionUrlAllowed(config, "https://studio.ximalaya.com/uploading"),
    false,
  );
  assert.equal(
    isContributionUrlAllowed(config, "https://podcaster.xiaoyuzhoufm.com/podcast/123"),
    true,
  );
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://podcaster.xiaoyuzhoufm.com/podcast/123/episode/create",
    ),
    true,
  );
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://podcaster.xiaoyuzhoufm.com/podcast/123/episode",
    ),
    false,
  );
  assert.equal(
    isContributionUrlAllowed(config, "https://podcaster.xiaoyuzhoufm.com/podcast"),
    false,
  );
  assert.equal(
    isContributionUrlAllowed(config, "https://podcaster.xiaoyuzhoufm.com/podcast/create"),
    false,
  );
  assert.equal(
    isContributionUrlAllowed(config, "https://podcaster.xiaoyuzhoufm.com/podcast/new"),
    false,
  );
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://podcaster.xiaoyuzhoufm.com/podcast/123/data-analysis/content",
    ),
    false,
  );
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://podcaster.xiaoyuzhoufm.com/podcast/123/interaction/comment",
    ),
    false,
  );
  assert.equal(isContributionUrlAllowed(config, "https://suno.com/discover"), false);
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://www.ximalaya.com/reform-upload/page/upload",
    ),
    true,
  );
  assert.equal(
    isContributionUrlAllowed(config, "https://studio.ximalaya.com/dashboard"),
    false,
  );
  assert.equal(
    isContributionUrlAllowed(config, "https://studio.ximalaya.com/uploading"),
    false,
  );
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://channels.weixin.qq.com/platform/post/create",
    ),
    true,
  );
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://channels.weixin.qq.com/platform/post/list?tab=post",
    ),
    false,
  );
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://creator.douyin.com/creator-micro/content/upload",
    ),
    true,
  );
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://creator.douyin.com/creator-micro/content/manage",
    ),
    false,
  );
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://creator.xiaohongshu.com/publish/publish?source=official",
    ),
    true,
  );
  assert.equal(
    isContributionUrlAllowed(config, "https://creator.xiaohongshu.com/new/home"),
    false,
  );
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://cp.kuaishou.com/article/publish/video",
    ),
    true,
  );
  assert.equal(
    isContributionUrlAllowed(config, "https://cp.kuaishou.com/article/manage/video"),
    false,
  );
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=10&token=123",
    ),
    true,
  );
  assert.equal(
    isContributionUrlAllowed(
      config,
      "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_ex&begin=0&count=5",
    ),
    false,
  );
  assert.equal(isContributionUrlAllowed(config, "https://mp.weixin.qq.com/"), false);
  assert.equal(isContributionUrlAllowed(config, "https://example.com/create"), false);
  assert.equal(isContributionUrlAllowed(config, "javascript:alert(1)"), false);
});

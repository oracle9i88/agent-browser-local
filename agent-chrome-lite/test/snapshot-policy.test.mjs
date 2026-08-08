import test from "node:test";
import assert from "node:assert/strict";

import {
  isContributionHint,
  isReadOnlyControl,
  SnapshotStore,
} from "../src/browser/snapshot.mjs";

function fakeCdp(nodes, metadata, semanticCandidates = {}) {
  return {
    async send(method, params = {}) {
      if (method === "Accessibility.getFullAXTree") return { nodes };
      if (method === "DOM.resolveNode") {
        return { object: { objectId: String(params.backendNodeId) } };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.returnByValue === false) {
          const candidate = semanticCandidates[params.objectId];
          return candidate
            ? { result: { objectId: candidate } }
            : { result: { subtype: "null" } };
        }
        return { result: { value: metadata[params.objectId] || {} } };
      }
      if (method === "DOM.describeNode") {
        return { node: { backendNodeId: Number(params.objectId) } };
      }
      throw new Error(`Unexpected CDP method: ${method}`);
    },
  };
}

test("dashboard snapshot suppresses readback controls and static page data", async () => {
  const store = new SnapshotStore();
  const result = await store.capture(
    fakeCdp(
      [
        { nodeId: "1", backendDOMNodeId: 1, role: { value: "button" }, name: { value: "内容管理" } },
        { nodeId: "2", backendDOMNodeId: 2, role: { value: "link" }, name: { value: "某用户 2026.08.05 一条评论" } },
        { nodeId: "3", role: { value: "StaticText" }, name: { value: "不应返回的统计数据" } },
      ],
      {
        1: { tag: "button", visible: true },
        2: { tag: "a", href: "https://example.test/podcast/one/interaction/comment", visible: true },
      },
    ),
    { title: "后台", url: "https://example.test/podcast/one" },
  );

  assert.deepEqual(result.controls, []);
  assert.deepEqual(result.hints, []);
});

test("semantic editor hints map to the nearest editable DOM ancestor", async () => {
  const store = new SnapshotStore();
  const result = await store.capture(
    fakeCdp(
      [
        {
          nodeId: "title-hint",
          backendDOMNodeId: 31,
          role: { value: "StaticText" },
          name: { value: "请在这里输入标题" },
        },
        {
          nodeId: "body-hint",
          backendDOMNodeId: 32,
          role: { value: "StaticText" },
          name: { value: "从这里开始写正文" },
        },
      ],
      {
        41: {
          tag: "div",
          contentEditable: true,
          placeholder: "请在这里输入标题",
          value: "",
          visible: true,
        },
        42: {
          tag: "div",
          contentEditable: true,
          placeholder: "从这里开始写正文",
          value: "第一段\n\n第二段\nhttps://example.test",
          visible: true,
        },
      },
      { 31: "41", 32: "42" },
    ),
    {
      title: "公众号",
      url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit",
    },
  );

  assert.equal(result.controls.length, 2);
  assert.equal(result.controls[0].name, "请在这里输入标题");
  assert.equal(result.controls[0].contentEditable, true);
  assert.equal(result.controls[1].name, "从这里开始写正文");
  assert.equal(
    result.controls[1].value,
    "第一段\n\n第二段\nhttps://example.test",
  );
});

test("empty rich editor does not report its placeholder as authored content", async () => {
  const store = new SnapshotStore();
  const result = await store.capture(
    fakeCdp(
      [
        {
          nodeId: "body-hint",
          backendDOMNodeId: 51,
          role: { value: "StaticText" },
          name: { value: "从这里开始写正文" },
        },
      ],
      {
        61: {
          tag: "div",
          contentEditable: true,
          placeholder: "从这里开始写正文",
          value: "从这里开始写正文\n\n",
          visible: true,
        },
      },
      { 51: "61" },
    ),
    {
      title: "公众号",
      url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit",
    },
  );

  assert.equal(result.controls[0].name, "从这里开始写正文");
  assert.equal(result.controls[0].value, "");
});

test("unfocused semantic editor remains discoverable as an activation ref", async () => {
  const store = new SnapshotStore();
  const result = await store.capture(
    fakeCdp(
      [
        {
          nodeId: "title-hint",
          backendDOMNodeId: 71,
          role: { value: "StaticText" },
          name: { value: "请在这里输入标题" },
        },
      ],
      {
        71: { tag: "div", visible: true },
      },
    ),
    {
      title: "公众号",
      url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit",
    },
  );

  assert.equal(result.controls.length, 1);
  assert.equal(result.controls[0].role, "editor_activation");
  assert.equal(result.controls[0].name, "请在这里输入标题");
  assert.equal(store.resolve(result.controls[0].ref).backendNodeId, 71);
});

test("semantic hint without a DOM id inherits the nearest AX parent mapping", async () => {
  const store = new SnapshotStore();
  const result = await store.capture(
    fakeCdp(
      [
        {
          nodeId: "title-container",
          backendDOMNodeId: 81,
          role: { value: "generic" },
          name: { value: "" },
        },
        {
          nodeId: "title-placeholder",
          parentId: "title-container",
          role: { value: "StaticText" },
          name: { value: "请在这里输入标题" },
        },
      ],
      {
        91: {
          tag: "div",
          contentEditable: true,
          value: "",
          visible: true,
        },
      },
      { 81: "91" },
    ),
    {
      title: "公众号",
      url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit",
    },
  );

  assert.equal(result.controls.length, 1);
  assert.equal(result.controls[0].role, "textbox");
  assert.equal(result.controls[0].name, "请在这里输入标题");
  assert.equal(store.resolve(result.controls[0].ref).backendNodeId, 91);
});

test("generic content labels are not promoted to editor activation refs", async () => {
  const store = new SnapshotStore();
  const result = await store.capture(
    fakeCdp(
      [
        {
          nodeId: "recommendation",
          backendDOMNodeId: 101,
          role: { value: "StaticText" },
          name: { value: "内容有可能被推荐至其他场景" },
        },
      ],
      { 101: { tag: "span", visible: true } },
    ),
    {
      title: "公众号",
      url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit",
    },
  );

  assert.deepEqual(result.controls, []);
});

test("ximalaya upload survives while management navigation is suppressed", () => {
  const pageUrl = "https://studio.ximalaya.com/upload";
  assert.equal(
    isReadOnlyControl({ role: "upload", name: "上传" }, pageUrl),
    false,
  );
  for (const name of [
    "首页",
    "消息",
    "在线客服",
    "帮助中心",
    "个人信息",
    "内容管理",
    "互动管理",
    "数据中心",
    "直播管理",
    "视频管理",
    "收入与服务",
    "带货中心",
    "问题咨询",
    "我的作品",
    "创作收益",
    "成长中心",
    "创作服务",
    "其他服务",
    "活动中心",
    "数据概览",
    "作品分析",
    "直播数据",
    "粉丝分析",
    "创作灵感",
    "热点榜单",
    "创作学院",
    "音乐人",
    "推广资源管理",
    "通知",
    "活动管理",
    "变现中心",
    "创作中心",
  ]) {
    assert.equal(
      isReadOnlyControl({ role: "button", name }, pageUrl),
      true,
      name,
    );
  }
});

test("upload rules remain hints instead of actionable upload refs", async () => {
  const store = new SnapshotStore();
  const result = await store.capture(
    fakeCdp(
      [
        {
          nodeId: "rules",
          backendDOMNodeId: 111,
          role: { value: "StaticText" },
          name: { value: "了解上传规则详情" },
        },
        {
          nodeId: "size",
          backendDOMNodeId: 112,
          role: { value: "StaticText" },
          name: { value: "视频时长60分钟以内，推荐上传mp4格式视频" },
        },
        {
          nodeId: "action",
          backendDOMNodeId: 113,
          role: { value: "StaticText" },
          name: { value: "点击上传 或直接将视频文件拖入此区域" },
        },
      ],
      {
        111: { tag: "span", visible: true },
        112: { tag: "span", visible: true },
        113: { tag: "span", visible: true },
      },
    ),
    {
      title: "抖音创作者中心",
      url: "https://creator.douyin.com/creator-micro/content/upload",
    },
  );

  assert.deepEqual(
    result.controls.map(({ role, name }) => ({ role, name })),
    [
      {
        role: "upload",
        name: "点击上传 或直接将视频文件拖入此区域",
      },
    ],
  );
});

test("video-channel hints expose only contribution context", async () => {
  for (const text of [
    "申政",
    "wideNavigation",
    "视频号 · 助手",
    "首页",
    "内容管理",
    "互动管理",
    "收入与服务",
    "数据中心",
    "通知中心",
    "草稿箱",
    "北京市",
    "© 1998-2026 Tencent Inc. All Rights Reserved.",
  ]) {
    assert.equal(isContributionHint(text), false, text);
  }
  for (const text of [
    "短标题",
    "视频描述",
    "添加描述",
    "声明原创",
    "选择合集",
    "定时发表",
    "保存草稿",
    "手机预览",
    "发表",
    "上传时长8小时内，大小不超过20GB",
  ]) {
    assert.equal(isContributionHint(text), true, text);
  }

  const store = new SnapshotStore();
  const result = await store.capture(
    fakeCdp(
      [
        {
          nodeId: "title",
          backendDOMNodeId: 20,
          role: { value: "textbox" },
          name: { value: "填写短标题有机会获得更多流量" },
        },
        { nodeId: "account", role: { value: "StaticText" }, name: { value: "申政" } },
        { nodeId: "manage", role: { value: "StaticText" }, name: { value: "内容管理" } },
        { nodeId: "description", role: { value: "StaticText" }, name: { value: "视频描述" } },
        { nodeId: "publish", role: { value: "StaticText" }, name: { value: "发表" } },
      ],
      {
        20: { tag: "input", type: "text", visible: true },
      },
    ),
    {
      title: "视频号发表",
      url: "https://channels.weixin.qq.com/platform/post/create",
    },
  );

  assert.deepEqual(result.hints, [
    { role: "StaticText", text: "视频描述" },
    { role: "StaticText", text: "发表" },
  ]);
});

test("stable snapshot retries a temporarily empty client-rendered page", async () => {
  const store = new SnapshotStore();
  const waits = [];
  let captures = 0;
  store.capture = async () => {
    captures += 1;
    return captures === 1
      ? { snapshotId: "early", controls: [], hints: [] }
      : {
          snapshotId: "ready",
          controls: [{ ref: "ready:1", role: "upload", name: "上传" }],
          hints: [],
        };
  };

  const result = await store.captureStable(null, null, {
    attempts: 3,
    intervalMs: 400,
    wait: async (ms) => waits.push(ms),
  });

  assert.equal(result.snapshotId, "ready");
  assert.equal(captures, 2);
  assert.deepEqual(waits, [400]);
});

test("contribution form exposes semantic editor and hidden native file input", async () => {
  const store = new SnapshotStore();
  const result = await store.capture(
    fakeCdp(
      [
        {
          nodeId: "editor",
          backendDOMNodeId: 10,
          role: { value: "textbox" },
          name: { value: "" },
          childIds: ["editor-hint"],
        },
        { nodeId: "editor-hint", role: { value: "StaticText" }, name: { value: "在这里编辑 Show Notes" } },
        { nodeId: "file", backendDOMNodeId: 11, ignored: true },
        { nodeId: "upload-text", backendDOMNodeId: 12, role: { value: "StaticText" }, name: { value: "点击上传封面" } },
        { nodeId: "heading", role: { value: "heading" }, name: { value: "创建单集" } },
      ],
      {
        10: {
          tag: "div",
          contentEditable: true,
          formAction: "https://example.test/create",
          value: "第一段\n\n第二段\nhttps://example.test",
          visible: true,
        },
        11: {
          tag: "input",
          type: "file",
          ariaLabel: "上传音频",
          visible: false,
        },
        12: { tag: "span", visible: true },
      },
    ),
    { title: "创建单集", url: "https://example.test/create" },
  );

  assert.equal(result.controls[0].name, "在这里编辑 Show Notes");
  assert.equal(result.controls[0].value, "第一段\n\n第二段\nhttps://example.test");
  assert.equal(result.controls[1].role, "upload");
  assert.equal(result.controls[1].name, "点击上传封面");
  assert.equal(result.controls[2].role, "file");
  assert.equal(result.controls[2].name, "上传音频");
  assert.deepEqual(result.hints, [
    { role: "StaticText", text: "在这里编辑 Show Notes" },
    { role: "StaticText", text: "点击上传封面" },
    { role: "heading", text: "创建单集" },
  ]);
});

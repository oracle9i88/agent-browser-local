const HUMAN_ONLY_ACTIONS = Object.freeze([
  "login-or-verification",
  "legal-consent",
  "create-or-publish",
  "delete",
  "payment",
]);

const PLATFORM_BACKLOG = Object.freeze({
  netease_cloud_music: Object.freeze({
    label: "网易云音乐",
    status: "pending_official_entry_validation",
    requirement:
      "正式启用前必须核验官方创作者入口、登录跳转和最终人工发布门；核验前不得写入 allowlist。",
  }),
});

const PLATFORM_REGISTRY = Object.freeze({
  xiaoyuzhou: Object.freeze({
    label: "小宇宙",
    contributionTargets: Object.freeze([
      Object.freeze({
        origin: "https://podcaster.xiaoyuzhoufm.com",
        // The /podcast root is an account/program collection. Program choice is
        // human-only; agents may act only after the user enters one concrete
        // podcast workspace. The only child route exposed is the verified
        // single-episode creation form; lists, analytics and interaction stay
        // outside contribution scope.
        pathTemplates: Object.freeze([
          "/podcast/:podcastId",
          "/podcast/:podcastId/episode/create",
        ]),
        excludedTemplateValues: Object.freeze({
          podcastId: Object.freeze(["create", "new"]),
        }),
      }),
    ]),
  }),
  ximalaya: Object.freeze({
    label: "喜马拉雅",
    evidence: "https://www.ximalaya.com/reform-upload/page/upload",
    contributionTargets: Object.freeze([
      Object.freeze({
        origin: "https://www.ximalaya.com",
        pathPrefixes: Object.freeze(["/reform-upload"]),
      }),
      Object.freeze({
        origin: "https://studio.ximalaya.com",
        pathPrefixes: Object.freeze(["/upload", "/uploadWorks"]),
      }),
    ]),
  }),
  zhihu: Object.freeze({
    label: "知乎专栏",
    evidence: "https://zhuanlan.zhihu.com/write",
    contributionTargets: Object.freeze([
      Object.freeze({
        origin: "https://zhuanlan.zhihu.com",
        pathPrefixes: Object.freeze(["/write"]),
      }),
    ]),
  }),
  suno: Object.freeze({
    label: "Suno",
    contributionTargets: Object.freeze([
      Object.freeze({
        origin: "https://suno.com",
        // Suno redirects first-time Studio visits to /studio-welcome before
        // entering /studio. Keep that onboarding surface contribution-scoped
        // without opening discovery/library pages.
        pathPrefixes: Object.freeze([
          "/create",
          "/studio",
          "/studio-welcome",
          "/song",
          "/me",
        ]),
      }),
    ]),
  }),
  wechat_official: Object.freeze({
    label: "微信公众号",
    contributionTargets: Object.freeze([
      Object.freeze({
        origin: "https://mp.weixin.qq.com",
        pathPrefixes: Object.freeze(["/cgi-bin/appmsg"]),
        requiredSearchParams: Object.freeze({
          action: Object.freeze(["edit"]),
          t: Object.freeze(["media/appmsg_edit", "media/appmsg_edit_v2"]),
        }),
      }),
    ]),
  }),
  wechat_channels: Object.freeze({
    label: "微信视频号",
    evidence:
      "https://findeross.weixin.qq.com/cgi-bin/mmfindernodelivecrmwebbroker-bin/helper-center/pages/Yhdpjlq2RIkcmnQu",
    contributionTargets: Object.freeze([
      Object.freeze({
        origin: "https://channels.weixin.qq.com",
        pathPrefixes: Object.freeze(["/platform/post/create"]),
      }),
    ]),
  }),
  douyin: Object.freeze({
    label: "抖音",
    evidence: "https://creator.douyin.com/creator-micro/content/upload",
    contributionTargets: Object.freeze([
      Object.freeze({
        origin: "https://creator.douyin.com",
        pathPrefixes: Object.freeze([
          "/creator-micro/content/upload",
          "/creator-micro/content/post/video",
          "/creator-micro/content/post/image",
        ]),
      }),
    ]),
  }),
  xiaohongshu: Object.freeze({
    label: "小红书",
    evidence: "https://creator.xiaohongshu.com/publish/publish",
    contributionTargets: Object.freeze([
      Object.freeze({
        origin: "https://creator.xiaohongshu.com",
        pathPrefixes: Object.freeze(["/publish", "/publish/publish"]),
      }),
    ]),
  }),
  kuaishou: Object.freeze({
    label: "快手",
    evidence: "https://cp.kuaishou.com/article/publish/video",
    contributionTargets: Object.freeze([
      Object.freeze({
        origin: "https://cp.kuaishou.com",
        pathPrefixes: Object.freeze(["/article/publish/video"]),
      }),
    ]),
  }),
});

export const DEFAULT_PLATFORM_IDS = Object.freeze(
  Object.keys(PLATFORM_REGISTRY).filter((platformId) => platformId !== "suno"),
);

// 受控下载来源是与投稿目标完全独立的一套登记：登记只代表 daemon 允许
// browser.download 向这些 origin 发起会话内逐条下载，不代表开放任何
// 页面导航、快照或抓取能力。新来源启用前必须确认其内容许可允许本机保存
// （例如 musopen 的公版/CC-PD 录音与乐谱）。
const DOWNLOAD_REGISTRY = Object.freeze({
  musopen: Object.freeze({
    label: "Musopen（公版古典音乐）",
    evidence: "https://musopen.org/music/",
    downloadSources: Object.freeze([
      Object.freeze({ origin: "https://musopen.org" }),
      Object.freeze({ origin: "https://dl.musopen.org" }),
    ]),
  }),
});

export const DEFAULT_DOWNLOAD_SOURCE_IDS = Object.freeze(
  Object.keys(DOWNLOAD_REGISTRY),
);
export { HUMAN_ONLY_ACTIONS, PLATFORM_BACKLOG, PLATFORM_REGISTRY, DOWNLOAD_REGISTRY };

function cloneDownloadSource(source) {
  return { ...source };
}

export function downloadSourcesFor(sourceIds = DEFAULT_DOWNLOAD_SOURCE_IDS) {
  const sources = [];
  for (const sourceId of sourceIds) {
    const entry = DOWNLOAD_REGISTRY[sourceId];
    if (!entry) {
      throw new Error(`Unknown download source: ${sourceId}`);
    }
    for (const source of entry.downloadSources) {
      sources.push(cloneDownloadSource({ source: sourceId, ...source }));
    }
  }
  return sources;
}

export function mergeDownloadSources(existingSources, sourceIds) {
  const authoritative = downloadSourcesFor(sourceIds);
  const authoritativeOrigins = new Set(authoritative.map((s) => s.origin));
  const merged = (existingSources || [])
    .filter((s) => !authoritativeOrigins.has(s.origin))
    .map(cloneDownloadSource);
  return [...merged, ...authoritative];
}

export function removeDownloadSources(existingSources, sourceIds) {
  const origins = new Set(downloadSourcesFor(sourceIds).map((s) => s.origin));
  return (existingSources || []).filter((s) => !origins.has(s.origin));
}

function cloneContributionTarget(target) {
  return {
    ...target,
    ...(target.pathPrefixes
      ? { pathPrefixes: [...target.pathPrefixes] }
      : {}),
    ...(target.pathTemplates
      ? { pathTemplates: [...target.pathTemplates] }
      : {}),
    ...(target.excludedTemplateValues
      ? {
          excludedTemplateValues: Object.fromEntries(
            Object.entries(target.excludedTemplateValues).map(([name, values]) => [
              name,
              [...values],
            ]),
          ),
        }
      : {}),
    ...(target.requiredSearchParams
      ? {
          requiredSearchParams: Object.fromEntries(
            Object.entries(target.requiredSearchParams).map(([name, values]) => [
              name,
              [...values],
            ]),
          ),
        }
      : {}),
  };
}

export function contributionTargetsFor(platformIds = DEFAULT_PLATFORM_IDS) {
  const targets = [];
  for (const platformId of platformIds) {
    const platform = PLATFORM_REGISTRY[platformId];
    if (!platform) {
      throw new Error(`Unknown platform: ${platformId}`);
    }
    for (const target of platform.contributionTargets) {
      targets.push(cloneContributionTarget({
        platform: platformId,
        ...target,
      }));
    }
  }
  return targets;
}

export function mergeContributionTargets(existingTargets, platformIds) {
  const authoritative = contributionTargetsFor(platformIds);
  const authoritativeOrigins = new Set(
    authoritative.map((target) => target.origin),
  );
  const merged = (existingTargets || [])
    .filter((target) => !authoritativeOrigins.has(target.origin))
    .map(cloneContributionTarget);
  return [...merged, ...authoritative];
}

// Security-critical registry tightenings must survive application upgrades
// even when the user's local config predates the new boundary. This function
// never enables a platform that the user removed; it only replaces an existing
// Xiaoyuzhou origin-wide target with the authoritative selected-program target.
export function hardenLegacyContributionTargets(existingTargets) {
  const targets = existingTargets || [];
  const origin = "https://podcaster.xiaoyuzhoufm.com";
  if (!targets.some((target) => target.origin === origin)) {
    return targets.map(cloneContributionTarget);
  }
  const preserved = targets
    .filter((target) => target.origin !== origin)
    .map(cloneContributionTarget);
  return [...preserved, ...contributionTargetsFor(["xiaoyuzhou"])];
}

export function removeContributionTargets(existingTargets, platformIds) {
  const origins = new Set(
    contributionTargetsFor(platformIds).map((target) => target.origin),
  );
  return (existingTargets || []).filter((target) => !origins.has(target.origin));
}

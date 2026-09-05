const finalizationWords = [
  /(^|\s)(publish|post|submit)(\s|$)/i,
  /创建(?:单集|歌曲)?|发布|发表|提交|上传(?:作品)?|立即发布/i,
];

const destructiveOrPaymentWords = [
  /(^|\s)(delete|trash|pay|purchase|buy|checkout|place order|confirm order)(\s|$)/i,
  /删除|移至垃圾箱|付款|支付|购买|下单|确认订单/i,
];

// 明确标注价格（"50 credits"）的入口与生成类动作一样，可委托给本地权限表
// 授予 browser.credits.suno 的 principal；未授权时仍然只能用户本人确认。
const creditQuotedWords = [/\b\d+\s*credits?\b/i];

// 生成类动作可委托给本地权限表授予 browser.credits.suno 的 principal。
const creditActionWords = [
  /create\s+song/i,
  /remaster/i,
  /add\s+(?:instrumental|vocal)/i,
  /replace\s+section/i,
  /生成(?:歌曲|音乐|分轨|midi)/i,
];

// 只有真正位于 Suno Studio 内的落盘入口才享受不限额下载规则。
// 普通歌曲页的 Download/MP3/WAV 计入月度额度；Get MIDI 可能消耗
// credits，二者都不能借 Studio 的一次性下载许可放行。
const studioDownloadWords = [
  /^multi-?track$/i,
];

// Suno accepts Multitrack as a normal browser download after an audited click.
// Clip-level Download .WAV is different: the site requires a real user gesture
// and did not start a download in packaged-app validation. Keep it manual-only
// instead of claiming unreliable automation support.
const studioManualDownloadWords = [/^download\s*\.?\s*wav$/i];

const getMidiWords = [/get\s+(?:stems?\s*\/\s*)?midi/i];

function isSunoStudioUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === "https://suno.com" &&
      (parsed.pathname === "/studio" || parsed.pathname.startsWith("/studio/"))
    );
  } catch {
    return false;
  }
}

const authWords = [
  /sign\s*in|log\s*in|verify|verification|captcha|one[- ]time code/i,
  /登录|登陆|验证码|验证身份|滑块/i,
];

const humanVerificationWords = [
  /i\s*(?:am|'m)\s+(?:a\s+)?human|not\s+a\s+robot|human\s+verification|prove\s+you(?:'re| are)\s+human/i,
  /人机验证|人类验证|我是人类|我不是机器人|安全验证|安全检查/i,
];

const legalWords = [
  /agree|agreement|terms|consent/i,
  /同意|协议|条款|授权|声明|原创/i,
];

function textOf(node) {
  return [
    node?.name,
    node?.ariaLabel,
    node?.text,
    node?.title,
    node?.href,
    node?.formAction,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function surfaceText(node) {
  return [
    textOf(node),
    node?.placeholder,
    node?.nameAttr,
    node?.autocomplete,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifySnapshotSurface(snapshot) {
  const controls = Array.isArray(snapshot?.controls) ? snapshot.controls : [];
  const hasAuthControl = controls.some((node) => {
    const type = String(node?.type || "").toLowerCase();
    const autocomplete = String(node?.autocomplete || "");
    return (
      type === "password" ||
      /password|one-time-code/i.test(autocomplete) ||
      matchesAny(surfaceText(node), authWords)
    );
  });

  const hasHumanVerification = controls.some((node) =>
    matchesAny(surfaceText(node), humanVerificationWords),
  );

  if (hasHumanVerification) {
    return {
      blocked: true,
      code: "human_verification_requires_handoff",
      reason: "检测到人机验证或‘我不是机器人’控件，必须由用户本人完成；Agent 不得代勾。",
    };
  }

  if (hasAuthControl) {
    return {
      blocked: true,
      code: "manual_auth_surface_requires_handoff",
      reason: "页面出现登录、密码、验证码或身份验证表单，必须由用户本人接管。",
    };
  }

  return { blocked: false };
}

export function classifyAction({ action, node, url }) {
  const text = `${textOf(node)} ${url || ""}`.trim();
  const type = String(node?.type || "").toLowerCase();
  const tag = String(node?.tag || "").toLowerCase();
  const role = String(node?.role || "").toLowerCase();

  if (action === "fill") {
    if (
      type === "password" ||
      /password|one-time-code/i.test(node?.autocomplete || "") ||
      matchesAny(text, authWords)
    ) {
      return {
        blocked: true,
        code: "manual_auth_required",
        reason: "登录、密码、验证码和身份验证必须由用户本人完成。",
      };
    }
    return { blocked: false };
  }

  if (action === "upload") {
    const nativeFileInput = tag === "input" && type === "file";
    const semanticUploadTrigger = role === "upload";
    if (!nativeFileInput && !semanticUploadTrigger) {
      return {
        blocked: true,
        code: "invalid_upload_target",
        reason: "上传只能绑定到 Snapshot 发现的原生文件输入或语义上传入口，并由 CDP 验证最终文件节点。",
      };
    }
    return { blocked: false };
  }

  if (action !== "click") return { blocked: false };

  if (matchesAny(text, humanVerificationWords)) {
    return {
      blocked: true,
      code: "human_verification_requires_handoff",
      reason: "检测到人机验证或‘我不是机器人’控件，必须由用户本人完成；Agent 不得代勾。",
    };
  }

  if (matchesAny(text, authWords)) {
    return {
      blocked: true,
      code: "manual_auth_required",
      reason: "登录或验证入口已交给用户本人操作。",
    };
  }
  if (matchesAny(text, legalWords) && ["checkbox", "switch"].includes(role)) {
    return {
      blocked: true,
      code: "legal_consent_required",
      reason: "协议、条款或授权确认需要用户本人完成，或由本地权限表明确授予代发布权限的 Agent 执行。",
      delegableCapability: "browser.finalize.ref",
    };
  }
  if (matchesAny(text, getMidiWords)) {
    return {
      blocked: true,
      code: "credit_action_requires_handoff",
      reason: "Get MIDI 可能消耗 credits，必须交给用户本人确认。",
    };
  }
  if (isSunoStudioUrl(url) && matchesAny(textOf(node), studioManualDownloadWords)) {
    return {
      blocked: true,
      code: "studio_single_track_requires_handoff",
      reason:
        "Suno Studio 单轨 Download .WAV 与系统保存流程需要用户本人完成；Agent 只能把片段菜单准备好。",
    };
  }
  if (isSunoStudioUrl(url) && matchesAny(textOf(node), studioDownloadWords)) {
    return {
      blocked: true,
      code: "studio_download_requires_finalize",
      reason:
        "Suno Studio 导出到本机需要本地权限表明确授予 browser.finalize.ref 的 Agent 执行，或由用户本人完成。",
      delegableCapability: "browser.finalize.ref",
    };
  }
  if (matchesAny(text, creditQuotedWords)) {
    return {
      blocked: true,
      code: "credit_action_requires_handoff",
      reason:
        "该动作明确标注消耗 credits，需要本地权限表明确授予 browser.credits.suno 的 Agent 执行，或由用户本人完成。",
      delegableCapability: "browser.credits.suno",
    };
  }
  if (matchesAny(text, creditActionWords)) {
    return {
      blocked: true,
      code: "credit_action_requires_handoff",
      reason:
        "该动作可能生成内容或消耗 credits，需要本地权限表明确授予 browser.credits.suno 的 Agent 执行，或由用户本人完成。",
      delegableCapability: "browser.credits.suno",
    };
  }

  const isActionControl = ["button", "menuitem"].includes(role) || tag === "button";
  if (isActionControl && matchesAny(text, destructiveOrPaymentWords)) {
    return {
      blocked: true,
      code: "destructive_action_requires_handoff",
      reason: "删除、支付、购买和下单等高风险动作必须由用户本人完成。",
    };
  }
  if (
    type === "submit" ||
    (isActionControl && matchesAny(text, finalizationWords))
  ) {
    return {
      blocked: true,
      code: "irreversible_action_requires_handoff",
      reason: "创建、提交和发布需要用户本人完成，或由本地权限表明确授予代发布权限的 Agent 执行。",
      delegableCapability: "browser.finalize.ref",
    };
  }

  return { blocked: false };
}

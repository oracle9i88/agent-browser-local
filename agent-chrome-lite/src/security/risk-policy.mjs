const irreversibleWords = [
  /(^|\s)(publish|post|submit|delete|trash|pay|purchase|buy|checkout|place order|confirm order)(\s|$)/i,
  /创建(?:单集|歌曲)?|发布|发表|提交|上传|删除|移至垃圾箱|付款|支付|购买|下单|确认订单|立即发布/i,
];

const creditWords = [
  /get\s+stems?\s*\/\s*midi/i,
  /create\s+song/i,
  /remaster/i,
  /add\s+(?:instrumental|vocal)/i,
  /replace\s+section/i,
  /生成(?:歌曲|音乐|分轨|midi)/i,
];

const authWords = [
  /sign\s*in|log\s*in|verify|verification|captcha|one[- ]time code/i,
  /登录|登陆|验证码|验证身份|滑块/i,
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
      reason: "协议、条款或授权确认必须由用户本人完成。",
    };
  }
  if (matchesAny(text, creditWords)) {
    return {
      blocked: true,
      code: "credit_action_requires_handoff",
      reason: "该动作可能生成内容或消耗 credits，P0 只允许拦截并交给用户。",
    };
  }

  const isActionControl = ["button", "menuitem"].includes(role) || tag === "button";
  if (
    type === "submit" ||
    (isActionControl && matchesAny(text, irreversibleWords))
  ) {
    return {
      blocked: true,
      code: "irreversible_action_requires_handoff",
      reason: "创建、提交、发布、删除、支付等不可逆动作必须由用户本人完成。",
    };
  }

  return { blocked: false };
}

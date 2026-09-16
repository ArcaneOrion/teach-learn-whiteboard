/**
 * 把技术错误翻译成人话
 *
 * 为什么必须单独做这一层：
 *
 * 浏览器把 **CORS 失败**和**网络不通**报成**同一句话** —— `TypeError: Failed to fetch`。
 * 用户完全猜不到原因，只会以为"这 App 坏了"。而实际上最常见的原因是
 * "这家渠道不允许从浏览器直连"，装到手机上走原生网络就好了。
 *
 * 这条对应产品设计里的一条原则：**出错时说人话**。
 */

/** 从各种可能的错误形状里抠出一段可读文本。**保证返回值一定是字符串** */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    // ⚠️ JSON.stringify(undefined) 返回的是 undefined，不是字符串 —— 这里要兜住
    const json: unknown = JSON.stringify(err);
    if (typeof json === 'string') return json;
  } catch {
    // 循环引用之类会抛，落到下面的兜底
  }
  return String(err);
}

/**
 * 鉴权类错误。
 *
 * 这个正则的每一条分支都是**照着实测抓到的真实报错**写的（见技术文档 §7.3 的探测）：
 *   DeepSeek   {"error":{"message":"Authentication Fails, Your api key: **** is invalid",...}}
 *   硅基流动    {"code":30014,"message":"Token is invalid."}
 *   智谱       {"error":{"code":"401","message":"token expired or incorrect"}}
 *   通义       {"error":{"message":"Incorrect API key provided..."}}
 *   Anthropic  {"error":{"type":"authentication_error","message":"invalid x-api-key"}}
 *
 * 各家措辞完全不一样，所以不能只认 "401" 这一个词。
 */
const AUTH_ERROR = new RegExp(
  [
    // ① 明确的 HTTP 状态码 / 单词
    '\\b(401|unauthorized|unauthenticated)\\b',
    // ② 形容词 + （可能带前缀的）名词：invalid x-api-key / Incorrect API key
    '(invalid|incorrect|expired|wrong|bad|missing|fail\\w*)[\\s\\S]{0,24}?(api[\\s_-]?)?(key|token|credential)',
    // ③ 名词 + 形容词：Token is invalid / token expired
    '(api[\\s_-]?)?(key|token|credential)\\s*(is\\s*)?(invalid|incorrect|expired|wrong|bad|missing|not\\s*found|fail\\w*)',
    // ④ 直接说鉴权
    'authentication\\s*(fail|error)',
  ].join('|'),
  'i',
);

/**
 * @param err   原始错误
 * @param where 'browser' = 跑在**网页环境**里（含安卓 App 的 WebView），
 *              'app' = 真正走原生 HTTP（现在的 Capacitor 配置**不是**这种）
 */
export function explainError(err: unknown, where: 'browser' | 'app' = 'browser'): string {
  const msg = messageOf(err);

  if (
    /Failed to fetch|NetworkError|Load failed|fetch failed|ECONNREFUSED|connection error|connection refused|network error|socket hang up|ENOTFOUND|ETIMEDOUT/i.test(
      msg,
    )
  ) {
    /**
     * ⚠️ 这段文案被改过两次，两次都是因为它**把排查方向指错了**。
     *
     * 第一版写「装到手机上走原生网络就能用」——**假话**。
     * 第二版把它按「浏览器 / App」二分——**分错了**：跨域是
     * **网页环境**的属性，不是「浏览器 vs App」的属性。安卓 App 里就是
     * 一个 WebView（origin 是 https://localhost），Capacitor 并没有关掉
     * 跨域检查，所以装上手机照样被拒。
     *
     * 这个错误假设的代价很具体：App 里判成 'app' 分支后，报错只说
     * 「地址不对／网络不通」，用户就会去改一个本来就对的地址 ——
     * 而真正的原因（跨域）一个字都没提。
     *
     * 实测的完整链路：ModelScope 用白名单式 CORS，而 OpenAI SDK 给每个请求
     * 自动加一串 `x-stainless-*`，白名单里没有它 → 预检被拒 →
     * 前端只拿到 `Failed to fetch`。curl / Node **不发预检**，
     * 所以「我用 curl 试过是通的」排除不了它。
     *
     * （那串头已在 corsSafeFetch.ts 里摘掉了；这条文案留作以后再遇到时的提示。）
     */
    const cors =
      where === 'browser'
        ? '① **这家渠道不允许网页直连**（跨域 CORS）—— 注意：用 curl / Postman 试是通的，因为它们不发预检，说明不了问题；'
        : '① 这家渠道连不上（地址不对或服务没在跑）；';
    return `连接失败。常见原因：${cors}② Base URL 填错了（一般要带 /v1）；③ 网络不通，或需要代理。`;
  }

  if (AUTH_ERROR.test(msg)) {
    return 'Key 不对或已过期。去「⚙️ 渠道」里检查一下。';
  }
  if (/\b403\b|forbidden|permission.?denied/i.test(msg)) {
    return '这家服务器拒绝了请求（403）。可能是 Key 权限不够，或者这个模型你没开通。';
  }
  if (/\b404\b|model.{0,12}not.{0,12}(found|exist)/i.test(msg)) {
    return '找不到这个模型。检查一下「模型 ID」有没有填对。';
  }
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(msg)) {
    return '请求太频繁被限流了（或额度用完了）。等一会儿再试。';
  }
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable/i.test(msg)) {
    return '模型厂商那边出错了（服务端错误）。过一会儿再试。';
  }
  if (/abort/i.test(msg)) return '已取消。';

  return msg;
}

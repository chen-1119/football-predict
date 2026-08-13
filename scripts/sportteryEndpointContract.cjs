const SPORTTERY_BASE = "https://webapi.sporttery.cn";

// The mobile calculator currently loads this endpoint from
// static.sporttery.cn/.../jc/jsq/dataTransfer.js. Keep it centralized so the
// collector, direct sync, and egress diagnostics cannot silently drift apart.
const SPORTTERY_CALCULATOR_URL =
  `${SPORTTERY_BASE}/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad,had`;
const SPORTTERY_CURRENT_URL =
  `${SPORTTERY_BASE}/gateway/uniform/football/getMatchListV1.qry?clientCode=3001`;
const SPORTTERY_RESULT_URL =
  `${SPORTTERY_BASE}/gateway/uniform/football/getUniformMatchResultV1.qry?matchPage=0`;
const SPORTTERY_CALCULATOR_REFERER =
  "https://m.sporttery.cn/mjc/jsq/zqhhgg/";
const SPORTTERY_RESULT_REFERER =
  "https://www.sporttery.cn/ltkj/";
const SPORTTERY_DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sportteryMatchDataReferer = (tab = "all") => (
  `https://m.sporttery.cn/mjc/zqsj/?tab=${encodeURIComponent(tab || "all")}`
);

const sportteryRefererForUrl = (url, tab = "all") => (
  /\/gateway\/uniform\/football\/getMatchCalculatorV1\.qry/i.test(String(url || ""))
    ? SPORTTERY_CALCULATOR_REFERER
    : /\/gateway\/uniform\/football\/getUniformMatchResultV1\.qry/i.test(String(url || ""))
      ? SPORTTERY_RESULT_REFERER
      : sportteryMatchDataReferer(tab)
);

const sportteryRequestHeaders = (
  url = SPORTTERY_CURRENT_URL,
  tab = "all",
  env = process.env,
) => Object.freeze({
  "User-Agent": String(
    env?.SPORTTERY_REQUEST_USER_AGENT || SPORTTERY_DEFAULT_USER_AGENT,
  ).trim() || SPORTTERY_DEFAULT_USER_AGENT,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Accept-Encoding": "identity",
  Referer: sportteryRefererForUrl(url, tab),
  Origin: /\/gateway\/uniform\/football\/getUniformMatchResultV1\.qry/i.test(String(url || ""))
    ? "https://www.sporttery.cn"
    : "https://m.sporttery.cn",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
});

module.exports = {
  SPORTTERY_BASE,
  SPORTTERY_CALCULATOR_URL,
  SPORTTERY_CURRENT_URL,
  SPORTTERY_RESULT_URL,
  SPORTTERY_CALCULATOR_REFERER,
  SPORTTERY_RESULT_REFERER,
  SPORTTERY_DEFAULT_USER_AGENT,
  sportteryMatchDataReferer,
  sportteryRefererForUrl,
  sportteryRequestHeaders,
};

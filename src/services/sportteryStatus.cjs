"use strict";

const officialVoidDisposition = (matchStatus, sellStatus, statusName = "") => {
  const raw = `${String(matchStatus || "").trim()} ${String(sellStatus || "").trim()} ${String(statusName || "").trim()}`;
  if (!/(?:取消竞猜|比赛取消|赛事取消|取消比赛|比赛中止|赛事中止|腰斩|\bcancelled\b|\bcanceled\b|\babandoned\b)/i.test(raw)) {
    return null;
  }
  return {
    resultDisposition: "VOID",
    voidReason: String(statusName || matchStatus || sellStatus || "official-cancellation").trim()
      || "official-cancellation",
  };
};

const statusFromSporttery = (
  matchStatus,
  sellStatus,
  statusName = "",
  kickoffTime = "",
  now = Date.now(),
) => {
  const matchRaw = String(matchStatus || "").trim();
  const sellRaw = String(sellStatus || "").trim();
  const nameRaw = String(statusName || "").trim();
  const lower = `${matchRaw} ${sellRaw} ${nameRaw}`.toLowerCase();
  const kickoffAt = Date.parse(kickoffTime);
  const nowMillis = now instanceof Date ? now.getTime() : Number(now);
  const kickoffStarted = Number.isFinite(kickoffAt)
    && Number.isFinite(nowMillis)
    && nowMillis >= kickoffAt;
  const hasAnyName = (names) => names.some((name) => nameRaw.includes(name));
  const explicitLive = (
    ["playing", "live", "inplay", "firsthalf", "secondhalf"]
      .some((status) => lower.includes(status))
    || hasAnyName(["进行中", "比赛中", "上半场", "下半场", "中场", "加时", "点球"])
    || (nameRaw.includes("暂停") && !nameRaw.includes("暂停销售"))
    || ["4", "5", "6", "7", "8", "9"].includes(matchRaw)
  );

  if (officialVoidDisposition(matchStatus, sellStatus, statusName)) return "PENDING_RESULT";
  if (["finished", "result", "ended", "completed"].some((status) => lower.includes(status))) {
    return "FINISHED";
  }
  if (matchRaw === "10" || hasAnyName(["待开奖", "待赛果", "待派奖", "等待开奖"])) {
    return "PENDING_RESULT";
  }
  if (["11", "12", "13"].includes(matchRaw)) return "FINISHED";
  if (hasAnyName(["完成", "完场", "赛果", "已开奖", "已派奖"])) return "FINISHED";

  // Provider live state is stronger than the scheduled clock. This ordering is
  // critical when a fixture starts early: treating it as scheduled until the
  // planned kickoff would admit in-play evidence into a pre-match ledger.
  if (explicitLive) return "LIVE";
  if (!kickoffStarted) return "SCHEDULED";

  if (matchRaw === "3" || sellRaw === "3" || nameRaw.includes("暂停销售")) {
    return kickoffStarted ? "LIVE" : "SCHEDULED";
  }
  if (kickoffStarted && ["2", "3"].includes(matchRaw)) return "LIVE";
  if (kickoffStarted && ["selling", "sell"].some((status) => lower.includes(status))) {
    return "LIVE";
  }
  return "SCHEDULED";
};

module.exports = {
  officialVoidDisposition,
  statusFromSporttery,
};

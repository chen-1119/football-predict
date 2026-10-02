// Explicit official calendar entries only; never infer source health or a new
// year's closure from an empty fixture response or a previous year's dates.
export const nationalDayClosure2026 = {
  id: 'cn-lottery-national-day-2026',
  startsAt: '2026-10-01T00:00:00+08:00',
  endsAtExclusive: '2026-10-05T00:00:00+08:00',
  sourceUrl: 'https://www.mof.gov.cn/gp/xxgkml/zhs/202512/t20251225_3980248.htm',
  sourceTitle: '财政部关于2026年彩票市场休市安排的公告',
} as const;

export function activeLotterySalesClosure(now: number) {
  return Number.isFinite(now)
    && now >= Date.parse(nationalDayClosure2026.startsAt)
    && now < Date.parse(nationalDayClosure2026.endsAtExclusive)
    ? nationalDayClosure2026 : null;
}

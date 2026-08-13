export type BigFiveLeagueKey = 'premier-league' | 'la-liga' | 'bundesliga' | 'serie-a' | 'ligue-1';

export type BigFiveSeasonStart = Readonly<{
  seasonKey: '2026/27';
  seasonStartUtc: string;
  localTimeZone: string;
  status: 'confirmed';
  openingFixture: Readonly<{ zh: string; en: string }>;
  officialSourceUrl: string;
  verifiedAt: string;
}>;

export const BIG_FIVE_SEASON_KEY = '2026/27' as const;

// Official league announcements are stored separately from match rows because
// the current feed may be empty during the off-season. Times are normalized to
// UTC and rendered in Asia/Shanghai by the UI.
export const BIG_FIVE_SEASON_CALENDAR: Readonly<Record<BigFiveLeagueKey, BigFiveSeasonStart>> = {
  'premier-league': {
    seasonKey: BIG_FIVE_SEASON_KEY,
    seasonStartUtc: '2026-08-21T19:00:00.000Z',
    localTimeZone: 'Europe/London',
    status: 'confirmed',
    openingFixture: { zh: '阿森纳 vs 考文垂', en: 'Arsenal vs Coventry City' },
    officialSourceUrl: 'https://www.premierleague.com/en/news/4675508/premier-league-fixture-schedulereleased-for-season-202627',
    verifiedAt: '2026-07-20T00:00:00.000Z'
  },
  'la-liga': {
    seasonKey: BIG_FIVE_SEASON_KEY,
    seasonStartUtc: '2026-08-15T17:00:00.000Z',
    localTimeZone: 'Europe/Madrid',
    status: 'confirmed',
    openingFixture: { zh: '阿拉维斯 vs 赫塔费', en: 'Deportivo Alavés vs Getafe' },
    officialSourceUrl: 'https://www.laliga.com/noticias/horarios-de-la-primera-jornada-de-laliga-ea-sports-2026-27',
    verifiedAt: '2026-07-20T00:00:00.000Z'
  },
  bundesliga: {
    seasonKey: BIG_FIVE_SEASON_KEY,
    seasonStartUtc: '2026-08-28T18:30:00.000Z',
    localTimeZone: 'Europe/Berlin',
    status: 'confirmed',
    openingFixture: { zh: '拜仁慕尼黑 vs 斯图加特', en: 'Bayern Munich vs VfB Stuttgart' },
    officialSourceUrl: 'https://www.bundesliga.com/en/bundesliga/news/2026-27-fixture-lists-now-available-38068',
    verifiedAt: '2026-07-20T00:00:00.000Z'
  },
  'serie-a': {
    seasonKey: BIG_FIVE_SEASON_KEY,
    seasonStartUtc: '2026-08-22T16:30:00.000Z',
    localTimeZone: 'Europe/Rome',
    status: 'confirmed',
    openingFixture: { zh: '国际米兰 vs 蒙扎等两场', en: 'Inter vs Monza and two co-openers' },
    officialSourceUrl: 'https://www.legaseriea.it/serie-a/news/date-orari-e-programmazione-tv-delle-prime-cinque-giornate',
    verifiedAt: '2026-07-20T00:00:00.000Z'
  },
  'ligue-1': {
    seasonKey: BIG_FIVE_SEASON_KEY,
    seasonStartUtc: '2026-08-21T18:45:00.000Z',
    localTimeZone: 'Europe/Paris',
    status: 'confirmed',
    openingFixture: { zh: '马赛 vs 斯特拉斯堡', en: 'Marseille vs Strasbourg' },
    officialSourceUrl: 'https://ligue1.com/fr/articles/l1_article_5435-programmation-tv-des-2-premieres-journees-de-ligue-1-mcdonald-s-2627',
    verifiedAt: '2026-07-20T00:00:00.000Z'
  }
};

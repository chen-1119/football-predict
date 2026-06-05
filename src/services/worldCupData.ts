import type { Match, PredictionDetail } from './mockData';
import { getLeagueById } from './entities';

export const WORLD_CUP_OFFICIAL = {
  name: {
    zh: '2026 世界杯',
    en: 'World Cup 2026'
  },
  host: {
    zh: '加拿大 / 墨西哥 / 美国',
    en: 'Canada / Mexico / USA'
  },
  startDate: '2026-06-11',
  finalDate: '2026-07-19',
  teams: 48,
  matches: 104,
  groups: 12,
  venues: 16
};

export const WORLD_CUP_STAGE_CARDS = [
  {
    title: { zh: '小组赛', en: 'Group Stage' },
    value: { zh: '12 组 x 4 队', en: '12 groups x 4 teams' },
    detail: {
      zh: '每组前 2 名 + 8 个成绩最好的小组第三进入 32 强。',
      en: 'Top two from each group plus eight best third-place teams reach the Round of 32.'
    }
  },
  {
    title: { zh: '淘汰赛', en: 'Knockout' },
    value: { zh: '32 强起步', en: 'Starts at R32' },
    detail: {
      zh: '32 强、16 强、8 强、半决赛、三四名、决赛全路径追踪。',
      en: 'Tracks Round of 32, Round of 16, quarters, semis, third place and final.'
    }
  },
  {
    title: { zh: '赛程窗口', en: 'Schedule Window' },
    value: { zh: '6/11 - 7/19', en: 'Jun 11 - Jul 19' },
    detail: {
      zh: '页面优先读取官方竞彩赛程；世界杯场次上线后自动纳入观察池。',
      en: 'The page prioritizes official Sporttery fixtures and folds World Cup matches into the watch pool.'
    }
  }
];

export const WORLD_CUP_PIPELINE_CARDS = [
  {
    title: { zh: '赛前概率', en: 'Pre-match Probability' },
    value: { zh: '胜平负 / 比分 / 大小球', en: '1X2 / score / goals' },
    detail: {
      zh: '沿用赔率基准、Elo、进球模型和风险标签，不只押热门。',
      en: 'Uses market baseline, Elo, goal model and risk tags instead of leaning only on favourites.'
    }
  },
  {
    title: { zh: 'SP 走势', en: 'SP Movement' },
    value: { zh: '快照留痕', en: 'Snapshot trail' },
    detail: {
      zh: '每次同步保存官方 SP，开赛后锁定预测，赛后按当时快照复盘。',
      en: 'Official SP snapshots are retained; picks lock after kickoff and review uses pre-match data.'
    }
  },
  {
    title: { zh: '晋级路径', en: 'Route Model' },
    value: { zh: '小组 -> 决赛', en: 'Groups -> Final' },
    detail: {
      zh: '专栏先展示路径框架，等赛程完整后补齐分组与淘汰赛概率。',
      en: 'The section starts with route structure, then fills group and knockout probabilities as data arrives.'
    }
  },
  {
    title: { zh: '赛后复盘', en: 'Post-match Review' },
    value: { zh: '命中率 + 校准', en: 'Hit rate + calibration' },
    detail: {
      zh: '保留历史分析，不用赛后信息回改预测，避免虚假提高准确率。',
      en: 'Keeps historical analysis unchanged and avoids post-match rewrites that inflate accuracy.'
    }
  }
];

const WORLD_CUP_MATCH_PATTERN = /世界杯|世预|国际赛|国际|友谊|国家队|world cup|qualification|qualifier|international|friendly|fifa|national/i;

export function getBestPrediction(match: Match): PredictionDetail | undefined {
  return match.predictions.find((prediction) => prediction.marketType === 'BEST')
    || match.predictions.find((prediction) => prediction.marketType === '1X2');
}

export function getMatchTrust(match: Match): number {
  return getBestPrediction(match)?.trustScore || 0;
}

export function isWorldCupRelevantMatch(match: Match): boolean {
  const league = getLeagueById(match.leagueId);
  const text = [
    match.leagueId,
    match.countryId,
    match.leagueName,
    match.leagueNameEn,
    match.leagueShortName,
    match.leagueShortNameEn,
    match.countryName,
    match.countryNameEn,
    league.name.zh,
    league.name.en,
    league.shortName.zh,
    league.shortName.en
  ].filter(Boolean).join(' ');

  return WORLD_CUP_MATCH_PATTERN.test(text);
}

export function getWorldCupWatchMatches(matches: Match[], max = 6): Match[] {
  const active = matches.filter((match) => match.status !== 'FINISHED');
  const relevant = active.filter(isWorldCupRelevantMatch);
  const source = relevant.length > 0 ? relevant : active;

  return [...source]
    .sort((a, b) => {
      const timeDiff = new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime();
      if (timeDiff !== 0) return timeDiff;
      return getMatchTrust(b) - getMatchTrust(a);
    })
    .slice(0, max);
}

export function getWorldCupRecentResults(matches: Match[], max = 4): Match[] {
  const relevantFinished = matches.filter((match) => match.status === 'FINISHED' && isWorldCupRelevantMatch(match));
  const source = relevantFinished.length > 0
    ? relevantFinished
    : matches.filter((match) => match.status === 'FINISHED');

  return [...source]
    .sort((a, b) => new Date(b.kickoffTime).getTime() - new Date(a.kickoffTime).getTime())
    .slice(0, max);
}

export function getDaysUntilWorldCup(now = new Date()): number {
  const start = new Date(`${WORLD_CUP_OFFICIAL.startDate}T00:00:00-05:00`).getTime();
  const diff = start - now.getTime();
  return Math.max(0, Math.ceil(diff / 86_400_000));
}

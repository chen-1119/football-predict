import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  ExternalLink,
  Radio,
  ShieldCheck
} from 'lucide-react';
import { TeamBadge } from '../components/TeamBadge';
import { useApp } from '../context/AppContextCore';
import {
  BIG_FIVE_SEASON_CALENDAR,
  BIG_FIVE_SEASON_KEY,
  type BigFiveLeagueKey
} from '../data/bigFiveSeasonCalendar';
import { getPredictionTipDisplay } from '../services/bettingDisplay';
import {
  getFormalRecommendationPrediction,
  getLiveRecommendationPrediction
} from '../services/displayRecommendation';
import { getTeamById } from '../services/entities';
import type { Match, PredictionDetail, Team } from '../services/mockData';
import '../styles/leagues.css';

type Language = 'zh' | 'en';
type LeagueKey = BigFiveLeagueKey;
type LeagueView = 'fixtures' | 'picks' | 'review';
type RecommendationTrack = 'formal' | 'live' | 'reference' | 'none';

type LeagueDefinition = {
  key: LeagueKey;
  zh: string;
  en: string;
  countryZh: string;
  countryEn: string;
  countryFlag: string;
  accent: string;
  countryIds: string[];
  countryPatterns: RegExp[];
  patterns: RegExp[];
  seasonStartUtc: string;
  openingFixture: Readonly<{ zh: string; en: string }>;
  officialSourceUrl: string;
  verifiedAt: string;
  startStatus: 'confirmed';
};

const BIG_FIVE_LEAGUES: LeagueDefinition[] = [
  {
    key: 'premier-league',
    zh: '英超',
    en: 'Premier League',
    countryZh: '英格兰',
    countryEn: 'England',
    countryFlag: '🇬🇧',
    accent: '#8b6df6',
    countryIds: ['eng'],
    countryPatterns: [/英格兰/i, /england/i],
    patterns: [/^(?:英超|英格兰(?:足球)?超级(?:联赛)?)$/i, /^(?:english\s+)?premier\s*league$/i],
    ...BIG_FIVE_SEASON_CALENDAR['premier-league'],
    startStatus: BIG_FIVE_SEASON_CALENDAR['premier-league'].status
  },
  {
    key: 'la-liga',
    zh: '西甲',
    en: 'La Liga',
    countryZh: '西班牙',
    countryEn: 'Spain',
    countryFlag: '🇪🇸',
    accent: '#f2c84b',
    countryIds: ['esp'],
    countryPatterns: [/西班牙/i, /spain/i],
    patterns: [/^(?:西甲|西班牙(?:足球)?甲级(?:联赛)?)$/i, /^(?:la\s*liga|primera\s*divisi[oó]n)$/i],
    ...BIG_FIVE_SEASON_CALENDAR['la-liga'],
    startStatus: BIG_FIVE_SEASON_CALENDAR['la-liga'].status
  },
  {
    key: 'bundesliga',
    zh: '德甲',
    en: 'Bundesliga',
    countryZh: '德国',
    countryEn: 'Germany',
    countryFlag: '🇩🇪',
    accent: '#ef6262',
    countryIds: ['deu', 'ger'],
    countryPatterns: [/德国/i, /germany/i],
    patterns: [/^(?:德甲|德国(?:足球)?甲级(?:联赛)?)$/i, /^(?:german\s+)?bundesliga$/i],
    ...BIG_FIVE_SEASON_CALENDAR.bundesliga,
    startStatus: BIG_FIVE_SEASON_CALENDAR.bundesliga.status
  },
  {
    key: 'serie-a',
    zh: '意甲',
    en: 'Serie A',
    countryZh: '意大利',
    countryEn: 'Italy',
    countryFlag: '🇮🇹',
    accent: '#5aa7f8',
    countryIds: ['ita'],
    countryPatterns: [/意大利/i, /italy/i],
    patterns: [/^(?:意甲|意大利(?:足球)?甲级(?:联赛)?)$/i, /^(?:italian\s+)?serie\s*a$/i],
    ...BIG_FIVE_SEASON_CALENDAR['serie-a'],
    startStatus: BIG_FIVE_SEASON_CALENDAR['serie-a'].status
  },
  {
    key: 'ligue-1',
    zh: '法甲',
    en: 'Ligue 1',
    countryZh: '法国',
    countryEn: 'France',
    countryFlag: '🇫🇷',
    accent: '#4bc7a2',
    countryIds: ['fra'],
    countryPatterns: [/法国/i, /france/i],
    patterns: [/^(?:法甲|法国(?:足球)?甲级(?:联赛)?)$/i, /^(?:french\s+)?ligue\s*1$/i],
    ...BIG_FIVE_SEASON_CALENDAR['ligue-1'],
    startStatus: BIG_FIVE_SEASON_CALENDAR['ligue-1'].status
  }
];

const matchLeagueNameSignals = (match: Match) => [
  match.leagueName,
  match.leagueNameEn,
  match.leagueShortName,
  match.leagueShortNameEn,
  match.externalSignals?.leagueName
].map((value) => String(value || '').trim()).filter(Boolean);

const NON_BIG_FIVE_LEAGUE_PATTERNS = [
  /^(?:巴甲|巴西(?:足球)?甲级(?:联赛)?)$/i,
  /^(?:campeonato\s+brasileiro(?:\s+s[eé]rie\s+a)?|brasileir[aã]o(?:\s+s[eé]rie\s+a)?|brazil(?:ian)?\s+s[eé]rie\s+a)$/i
];

const matchLeagueSignals = (match: Match) => [
  match.leagueId,
  ...matchLeagueNameSignals(match)
].map((value) => String(value || '').trim()).filter(Boolean);

const getLeagueForMatch = (match: Match) => {
  const nameSignals = matchLeagueNameSignals(match);
  if (nameSignals.some((signal) => NON_BIG_FIVE_LEAGUE_PATTERNS.some((pattern) => pattern.test(signal)))) {
    return undefined;
  }
  const leagueSignals = matchLeagueSignals(match);
  const text = leagueSignals.join(' ');
  if (/女足|女子|U\s?\d{2}|青年|预备队|Women|Youth|Reserve|\bCup\b|杯赛/i.test(text)) return undefined;
  const countryId = String(match.countryId || '').trim().toLowerCase();
  const countryText = `${match.countryName || ''} ${match.countryId || ''}`;
  return BIG_FIVE_LEAGUES.find((league) => {
    const exactChineseLeague = [match.leagueName, match.leagueShortName]
      .some((value) => String(value || '').trim() === league.zh);
    if (exactChineseLeague) return true;
    const countryMatches = league.countryIds.includes(countryId)
      || league.countryPatterns.some((pattern) => pattern.test(countryText));
    return countryMatches && league.patterns.some((pattern) => (
      leagueSignals.some((signal) => pattern.test(signal))
    ));
  });
};

const getMatchDisplayTeam = (match: Match, side: 'home' | 'away'): Team => {
  const isHome = side === 'home';
  const base = getTeamById(isHome ? match.homeTeamId : match.awayTeamId);
  const nameZh = (isHome ? match.homeTeamName : match.awayTeamName) || base.name.zh;
  const nameEn = (isHome ? match.homeTeamNameEn : match.awayTeamNameEn) || base.name.en || nameZh;
  const logo = isHome ? match.homeTeamLogo : match.awayTeamLogo;
  const logoType = isHome ? match.homeTeamLogoType : match.awayTeamLogoType;
  const countryIso = isHome ? match.homeTeamCountryIso : match.awayTeamCountryIso;

  return {
    ...base,
    name: { zh: nameZh, en: nameEn },
    shortName: { zh: nameZh, en: nameEn },
    logo: logo || countryIso || base.logo,
    logoType: logoType || base.logoType,
    color: (isHome ? match.homeTeamColor : match.awayTeamColor) || base.color,
    value: (isHome ? match.homeTeamValue : match.awayTeamValue) || base.value
  };
};

const getReferencePrediction = (match: Match) => (
  (match.predictions || []).find((prediction) => (
    prediction.marketType === 'BEST'
    && prediction.tipCode !== 'WATCH'
  ))
  || (match.predictions || []).find((prediction) => (
    prediction.marketType === '1X2'
    && prediction.tipCode !== 'WATCH'
  ))
);

const getRecommendationState = (match: Match) => {
  const formal = getFormalRecommendationPrediction(match);
  if (formal) return { track: 'formal' as RecommendationTrack, prediction: formal };

  const live = getLiveRecommendationPrediction(match);
  if (live) return { track: 'live' as RecommendationTrack, prediction: live };

  const reference = getReferencePrediction(match);
  if (reference) return { track: 'reference' as RecommendationTrack, prediction: reference };

  return { track: 'none' as RecommendationTrack, prediction: undefined };
};

const ZONED_ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const strictKickoffEpoch = (value: string | undefined) => {
  const match = ZONED_ISO_PATTERN.exec(String(value || '').trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const maxDay = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (day < 1 || day > maxDay || hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const epoch = Date.parse(String(value));
  return Number.isFinite(epoch) ? epoch : null;
};

const formatZonedKickoff = (
  iso: string,
  language: Language,
  options: Intl.DateTimeFormatOptions
) => {
  const epoch = strictKickoffEpoch(iso);
  if (epoch === null) return language === 'zh' ? '时间待确认' : 'Time pending';
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    ...options
  }).format(new Date(epoch));
};

const formatKickoff = (iso: string, language: Language) => formatZonedKickoff(iso, language, {
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit'
});

const formatLeagueStart = (iso: string, language: Language, compact = false) => formatZonedKickoff(iso, language, {
  year: compact ? undefined : 'numeric',
  month: compact ? '2-digit' : 'short',
  day: '2-digit',
  weekday: compact ? undefined : 'short',
  hour: '2-digit',
  minute: '2-digit'
});

const leagueStartCountdown = (iso: string, language: Language, now = Date.now()) => {
  const epoch = strictKickoffEpoch(iso);
  if (epoch === null) return language === 'zh' ? '时间待确认' : 'Time pending';
  const delta = epoch - now;
  if (delta <= 0) return language === 'zh' ? '新赛季已开赛' : 'Season started';
  const days = Math.max(1, Math.ceil(delta / 86_400_000));
  return language === 'zh' ? `还有 ${days} 天` : `${days} days to go`;
};

const getScore = (match: Match) => (
  Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)
    ? `${match.scoreHome}:${match.scoreAway}`
    : 'VS'
);

const isOpenFixture = (match: Match, now: number) => {
  const kickoff = strictKickoffEpoch(match.kickoffTime);
  if (kickoff === null) return false;
  return match.status === 'LIVE' || (match.status === 'SCHEDULED' && kickoff > now);
};
const isReviewFixture = (match: Match) => (
  match.status === 'FINISHED' || match.resultDisposition === 'VOID'
);
const sortByKickoff = (direction: 1 | -1) => (a: Match, b: Match) => {
  const aEpoch = strictKickoffEpoch(a.kickoffTime) ?? 0;
  const bEpoch = strictKickoffEpoch(b.kickoffTime) ?? 0;
  return ((aEpoch - bEpoch) * direction) || a.id.localeCompare(b.id);
};

const recommendationLabel = (
  track: RecommendationTrack,
  prediction: PredictionDetail | undefined,
  language: Language
) => {
  if (track === 'none' || !prediction) {
    return language === 'zh' ? '未发布推荐' : 'No published pick';
  }
  const direction = getPredictionTipDisplay(prediction, language);
  if (track === 'formal') return language === 'zh' ? `正式推荐 · ${direction}` : `Formal pick · ${direction}`;
  if (track === 'live') return language === 'zh' ? `实时推荐 · ${direction}` : `Live pick · ${direction}`;
  return language === 'zh' ? `分析参考 · ${direction}` : `Analysis reference · ${direction}`;
};

const MatchCard = ({
  match,
  language,
  onOpen
}: {
  match: Match;
  language: Language;
  onOpen: () => void;
}) => {
  const league = getLeagueForMatch(match);
  const home = getMatchDisplayTeam(match, 'home');
  const away = getMatchDisplayTeam(match, 'away');
  const recommendation = getRecommendationState(match);
  const prediction = recommendation.prediction;
  const market = prediction?.oddsPoolCode
    ? `${prediction.oddsPoolCode}${prediction.oddsPoolCode === 'HHAD' && prediction.handicapLine ? ` ${prediction.handicapLine}` : ''}`
    : (language === 'zh' ? '盘口待确认' : 'Market pending');
  const odds = Number(prediction?.odds);
  const statusText = match.resultDisposition === 'VOID'
    ? (language === 'zh' ? '已取消 / 退款' : 'Void / refunded')
    : match.status === 'LIVE'
    ? (language === 'zh' ? '进行中' : 'Live')
    : match.status === 'PENDING_RESULT'
      ? (language === 'zh' ? '待赛果' : 'Result pending')
      : match.status === 'FINISHED'
        ? (language === 'zh' ? '完赛' : 'Finished')
        : (language === 'zh' ? '待开赛' : 'Scheduled');

  return (
    <article className="league-match-card" data-track={recommendation.track}>
      <button
        type="button"
        className="league-match-card__open"
        onClick={onOpen}
        aria-label={`${home.name[language]} vs ${away.name[language]} · ${formatKickoff(match.kickoffTime, language)}`}
      >
        <span className="league-match-card__topline">
          <span className="league-match-card__kickoff">
            <Clock3 size={14} aria-hidden="true" />
            <time dateTime={match.kickoffTime}>{formatKickoff(match.kickoffTime, language)}</time>
            <small>{language === 'zh' ? '北京时间' : 'Beijing time'}</small>
          </span>
          <span>{league?.[language] || match.leagueShortName || match.leagueName || statusText}</span>
          <b>{statusText}</b>
        </span>

        <span className="league-match-card__body">
          <span className="league-match-card__teams">
            <span className="league-match-card__team">
              <TeamBadge team={home} size="md" />
              <strong>{home.shortName[language] || home.name[language]}</strong>
            </span>
            <span className="league-match-card__score" aria-label={language === 'zh' ? '比分或对阵' : 'Score or fixture'}>
              {getScore(match)}
            </span>
            <span className="league-match-card__team is-away">
              <TeamBadge team={away} size="md" />
              <strong>{away.shortName[language] || away.name[language]}</strong>
            </span>
          </span>

          <span className="league-match-card__market">
            <small>
              {recommendation.track === 'formal' || recommendation.track === 'live'
                ? (language === 'zh' ? '玩法 / 发布 SP' : 'Market / published SP')
                : (language === 'zh' ? '玩法 / 参考 SP' : 'Market / reference SP')}
            </small>
            <strong>{market}</strong>
            <b>{Number.isFinite(odds) && odds > 1 ? odds.toFixed(2) : '--'}</b>
          </span>
        </span>

        <span className={`league-match-card__recommendation is-${recommendation.track}`}>
          <span>{recommendationLabel(recommendation.track, prediction, language)}</span>
          {recommendation.track === 'reference' && (
            <small>{language === 'zh' ? '仅供分析，不计入正式命中率' : 'Analysis only; excluded from formal hit rate'}</small>
          )}
          {recommendation.track === 'live' && (
            <small>{language === 'zh' ? '已发布记录，独立于正式统计' : 'Published live record; separate from formal stats'}</small>
          )}
          <ChevronRight size={16} aria-hidden="true" />
        </span>
      </button>
    </article>
  );
};

export function BigFiveLeagues({ onSelectMatch }: { onSelectMatch: (matchId: string) => void }) {
  const { language, matches, dataSync } = useApp();
  const [selectedLeague, setSelectedLeague] = useState<LeagueKey>('premier-league');
  const [activeView, setActiveView] = useState<LeagueView>('fixtures');
  const [renderNow, setRenderNow] = useState(() => Date.now());
  const season = BIG_FIVE_SEASON_KEY;

  useEffect(() => {
    const timer = window.setInterval(() => setRenderNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const bigFiveMatches = useMemo(() => matches.filter((match) => Boolean(getLeagueForMatch(match))), [matches]);
  const selectedDefinition = BIG_FIVE_LEAGUES.find((league) => league.key === selectedLeague) || BIG_FIVE_LEAGUES[0];
  const selectedMatches = useMemo(() => bigFiveMatches.filter((match) => (
    getLeagueForMatch(match)?.key === selectedLeague
  )), [bigFiveMatches, selectedLeague]);

  const upcomingMatches = useMemo(() => selectedMatches
    .filter((match) => isOpenFixture(match, renderNow))
    .sort((a, b) => {
      if (a.status === 'LIVE' && b.status !== 'LIVE') return -1;
      if (b.status === 'LIVE' && a.status !== 'LIVE') return 1;
      return sortByKickoff(1)(a, b);
    }), [selectedMatches, renderNow]);
  const reviewMatches = useMemo(() => selectedMatches
    .filter(isReviewFixture)
    .sort(sortByKickoff(-1)), [selectedMatches]);
  const recommendationMatches = useMemo(() => selectedMatches
    .filter((match) => {
      if (!isOpenFixture(match, renderNow)) return false;
      const track = getRecommendationState(match).track;
      return track === 'formal' || track === 'live' || track === 'reference';
    })
    .sort(sortByKickoff(1)), [selectedMatches, renderNow]);

  const formalCount = upcomingMatches.filter((match) => getRecommendationState(match).track === 'formal').length;
  const liveCount = upcomingMatches.filter((match) => getRecommendationState(match).track === 'live').length;
  const referenceCount = upcomingMatches.filter((match) => getRecommendationState(match).track === 'reference').length;
  const coveredCount = selectedMatches.filter((match) => (
    Boolean(match.odds || match.handicapOdds) && (match.predictions || []).length > 0
  )).length;
  const coverage = selectedMatches.length ? Math.round((coveredCount / selectedMatches.length) * 100) : 0;
  const liveMatch = upcomingMatches.find((match) => match.status === 'LIVE');
  const nextMatch = upcomingMatches.find((match) => match.status === 'SCHEDULED');
  const headerMatch = liveMatch || nextMatch;
  const headerHome = headerMatch ? getMatchDisplayTeam(headerMatch, 'home') : undefined;
  const headerAway = headerMatch ? getMatchDisplayTeam(headerMatch, 'away') : undefined;
  const headerMatchCopy = headerMatch && headerHome && headerAway
    ? `${liveMatch ? (language === 'zh' ? '正在进行' : 'Live now') : (language === 'zh' ? '下一场' : 'Next')} · ${headerHome.shortName[language] || headerHome.name[language]} vs ${headerAway.shortName[language] || headerAway.name[language]} · ${formatKickoff(headerMatch.kickoffTime, language)}${language === 'zh' ? '（北京时间）' : ' (Beijing time)'}`
    : (language === 'zh' ? '比赛级赛程待同步 · 官方开赛时间见上方' : 'Fixture feed pending · official season start shown above');
  const viewMatches = activeView === 'fixtures'
    ? upcomingMatches
    : activeView === 'picks'
      ? recommendationMatches
      : reviewMatches;
  const visibleMatches = viewMatches.slice(0, 10);

  const emptyCopy = activeView === 'fixtures'
    ? {
        title: language === 'zh' ? '当前没有已同步的新赛季场次' : 'No new-season fixtures are synced yet',
        body: language === 'zh'
          ? '新赛季开幕时间已经由联赛官方确认；比赛级赛程仍在同步。可以先查看上一轮复盘，新场次入库后会自动显示。'
          : 'The official season start is confirmed while match-level fixtures are still syncing. Review the previous round until new fixtures arrive.',
        action: language === 'zh' ? '查看最近复盘' : 'Open recent reviews'
      }
    : activeView === 'picks'
      ? {
          title: language === 'zh' ? '当前没有通过门槛的推荐' : 'No recommendation has passed the gate',
          body: language === 'zh'
            ? '系统不会为了填满页面而强行给方向；分析参考也不会计入推荐数量。'
            : 'The system does not force directions to fill the page, and analysis references are not counted as picks.',
          action: language === 'zh' ? '查看赛程状态' : 'Open fixtures'
        }
      : {
          title: language === 'zh' ? '暂时没有可复盘赛果' : 'No settled reviews yet',
          body: language === 'zh' ? '等待官方赛果完成结算后再进入复盘。' : 'Reviews appear only after official settlement.',
          action: language === 'zh' ? '查看赛程状态' : 'Open fixtures'
        };

  const switchEmptyView = () => {
    if (activeView === 'fixtures') setActiveView('review');
    else setActiveView('fixtures');
  };

  return (
    <div className="leagues-page">
      <section className="leagues-hero" aria-labelledby="leagues-title">
        <div className="leagues-hero__copy">
          <span className="leagues-eyebrow">
            <ShieldCheck size={15} aria-hidden="true" />
            {language === 'zh' ? '五大联赛常态工作台' : 'Big Five League Desk'}
          </span>
          <h1 id="leagues-title">{language === 'zh' ? '五大联赛' : 'Europe’s Big Five'}</h1>
          <p>
            {language === 'zh'
              ? '英超、西甲、德甲、意甲、法甲统一查看赛程、已发布推荐与赛后复盘；推荐轨道严格分开，不展示虚假命中率。'
              : 'Premier League, La Liga, Bundesliga, Serie A and Ligue 1 fixtures, published picks and reviews in one disciplined workspace.'}
          </p>
        </div>
        <div className="leagues-hero__stats" aria-label={language === 'zh' ? '五大联赛数据概览' : 'Big Five data summary'}>
          <article>
            <CalendarDays size={18} aria-hidden="true" />
            <span>{language === 'zh' ? '赛季' : 'Season'}</span>
            <strong>{season}</strong>
          </article>
          <article>
            <Database size={18} aria-hidden="true" />
            <span>{language === 'zh' ? '已加载场次' : 'Loaded matches'}</span>
            <strong>{bigFiveMatches.length}</strong>
          </article>
          <article>
            <Radio size={18} aria-hidden="true" />
            <span>{language === 'zh' ? '推荐 / 参考' : 'Picks / references'}</span>
            <strong>{recommendationMatches.length}</strong>
          </article>
        </div>
      </section>

      <section className="leagues-opening-board" aria-labelledby="league-opening-title">
        <header className="leagues-opening-board__header">
          <div>
            <span>{season}</span>
            <h2 id="league-opening-title">{language === 'zh' ? '五大联赛开赛时间' : 'Big Five season kick-offs'}</h2>
          </div>
          <p>
            <Clock3 size={15} aria-hidden="true" />
            {language === 'zh' ? '均已换算为北京时间，时间来自各联赛官方赛程' : 'Converted to Beijing time from official league schedules'}
          </p>
        </header>
        <div className="leagues-opening-board__grid">
          {BIG_FIVE_LEAGUES.map((league) => {
            const isActive = league.key === selectedLeague;
            return (
              <article
                key={league.key}
                className={isActive ? 'is-active' : undefined}
                style={{ '--league-accent': league.accent } as CSSProperties}
              >
                <button
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => {
                    setSelectedLeague(league.key);
                    setActiveView('fixtures');
                  }}
                >
                  <span className="leagues-opening-board__league">
                    <i aria-hidden="true">{league.countryFlag}</i>
                    <span>
                      <strong>{league[language]}</strong>
                      <small>
                        {language === 'zh' ? '官方确认' : 'Confirmed'}
                        {' · '}
                        {leagueStartCountdown(league.seasonStartUtc, language)}
                      </small>
                    </span>
                  </span>
                  <time dateTime={league.seasonStartUtc}>{formatLeagueStart(league.seasonStartUtc, language)}</time>
                  <small className="leagues-opening-board__fixture">{league.openingFixture[language]}</small>
                </button>
                <a href={league.officialSourceUrl} target="_blank" rel="noreferrer">
                  {language === 'zh' ? '官方赛程' : 'Official schedule'}
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              </article>
            );
          })}
        </div>
      </section>

      <section className="leagues-workbench">
        <aside className="leagues-rail" aria-label={language === 'zh' ? '选择联赛' : 'Select league'}>
          <header>
            <span>{language === 'zh' ? '联赛切换' : 'Leagues'}</span>
            <small>{season}</small>
          </header>
          <div className="leagues-rail__list">
            {BIG_FIVE_LEAGUES.map((league) => {
              const leagueMatches = bigFiveMatches.filter((match) => getLeagueForMatch(match)?.key === league.key);
              const leagueUpcoming = leagueMatches.filter((match) => isOpenFixture(match, renderNow)).length;
              const isActive = league.key === selectedLeague;
              return (
                <button
                  type="button"
                  key={league.key}
                  className={isActive ? 'is-active' : undefined}
                  aria-pressed={isActive}
                  style={{ '--league-accent': league.accent } as CSSProperties}
                  onClick={() => setSelectedLeague(league.key)}
                >
                  <span className="leagues-rail__flag" aria-hidden="true">{league.countryFlag}</span>
                  <span>
                    <strong>{league[language]}</strong>
                    <small>
                      {language === 'zh' ? league.countryZh : league.countryEn}
                      {' · '}
                      {formatLeagueStart(league.seasonStartUtc, language, true)}
                    </small>
                  </span>
                  <b>{leagueUpcoming}</b>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="leagues-main">
          <header className="leagues-main__header">
            <div>
              <span>{selectedDefinition.countryFlag} {language === 'zh' ? selectedDefinition.countryZh : selectedDefinition.countryEn}</span>
              <h2>{selectedDefinition[language]}</h2>
              <p className="leagues-main__season-start">
                <Clock3 size={14} aria-hidden="true" />
                <span>{language === 'zh' ? '新赛季开赛' : 'Season starts'}</span>
                <time dateTime={selectedDefinition.seasonStartUtc}>
                  {formatLeagueStart(selectedDefinition.seasonStartUtc, language)}
                </time>
                <b>{leagueStartCountdown(selectedDefinition.seasonStartUtc, language)}</b>
              </p>
              <p className="leagues-main__next-match">
                {headerMatchCopy}
              </p>
            </div>
            <span className={`leagues-data-pill ${dataSync.serviceDataFresh === true ? 'is-ready' : 'is-watch'}`}>
              {dataSync.serviceDataFresh === true
                ? (language === 'zh' ? '数据已同步' : 'Data synced')
                : (language === 'zh' ? '数据状态待确认' : 'Data status pending')}
            </span>
          </header>

          <div className="leagues-tabs" role="tablist" aria-label={language === 'zh' ? '联赛视图' : 'League views'}>
            {([
              ['fixtures', language === 'zh' ? '赛程' : 'Fixtures', upcomingMatches.length],
              ['picks', language === 'zh' ? '推荐 / 参考' : 'Picks / references', recommendationMatches.length],
              ['review', language === 'zh' ? '复盘' : 'Review', reviewMatches.length]
            ] as Array<[LeagueView, string, number]>).map(([key, label, count]) => (
              <button
                type="button"
                role="tab"
                key={key}
                aria-selected={activeView === key}
                className={activeView === key ? 'is-active' : undefined}
                onClick={() => setActiveView(key)}
              >
                <span>{label}</span>
                <b>{count}</b>
              </button>
            ))}
          </div>

          <div className="leagues-match-list" role="tabpanel">
            {visibleMatches.length > 0 ? visibleMatches.map((match) => (
              <MatchCard
                key={match.id}
                match={match}
                language={language}
                onOpen={() => onSelectMatch(match.id)}
              />
            )) : (
              <div className="leagues-empty">
                <span aria-hidden="true"><CalendarDays size={28} /></span>
                <h3>{emptyCopy.title}</h3>
                <p>{emptyCopy.body}</p>
                {activeView === 'fixtures' && (
                  <p className="leagues-empty__opening">
                    {language === 'zh' ? '官方开赛：' : 'Official start: '}
                    <time dateTime={selectedDefinition.seasonStartUtc}>
                      {formatLeagueStart(selectedDefinition.seasonStartUtc, language)}
                    </time>
                    <strong>{leagueStartCountdown(selectedDefinition.seasonStartUtc, language)}</strong>
                  </p>
                )}
                <button type="button" onClick={switchEmptyView}>
                  {emptyCopy.action}
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        </main>

        <aside className="leagues-side" aria-label={language === 'zh' ? '联赛数据摘要' : 'League data summary'}>
          <section>
            <header>
              <span>{language === 'zh' ? '当前覆盖' : 'Current coverage'}</span>
              <Database size={16} aria-hidden="true" />
            </header>
            <div className="leagues-side__metric">
              <strong>{coverage}%</strong>
              <span>{language === 'zh' ? '赔率 + 模型同时可用' : 'Odds + model available'}</span>
            </div>
            <div className="leagues-side__bar" aria-hidden="true">
              <span style={{ width: `${coverage}%` }} />
            </div>
            <dl>
              <div><dt>{language === 'zh' ? '历史/当前场次' : 'Loaded fixtures'}</dt><dd>{selectedMatches.length}</dd></div>
              <div><dt>{language === 'zh' ? '正式推荐' : 'Formal picks'}</dt><dd>{formalCount}</dd></div>
              <div><dt>{language === 'zh' ? '实时发布' : 'Live published'}</dt><dd>{liveCount}</dd></div>
              <div><dt>{language === 'zh' ? '分析参考' : 'Analysis references'}</dt><dd>{referenceCount}</dd></div>
            </dl>
          </section>

          <section>
            <header>
              <span>{language === 'zh' ? '推荐口径' : 'Pick policy'}</span>
              <ShieldCheck size={16} aria-hidden="true" />
            </header>
            <ul className="leagues-policy-list">
              <li><CheckCircle2 size={14} />{language === 'zh' ? '正式推荐独立统计' : 'Formal picks tracked separately'}</li>
              <li><Radio size={14} />{language === 'zh' ? '实时发布保留发布时 SP' : 'Live picks retain publication SP'}</li>
              <li><CircleAlert size={14} />{language === 'zh' ? '分析参考不计命中率' : 'References excluded from hit rate'}</li>
            </ul>
          </section>

          <section>
            <header>
              <span>{language === 'zh' ? '最近赛果' : 'Recent results'}</span>
              <ChevronRight size={16} aria-hidden="true" />
            </header>
            <div className="leagues-recent-list">
              {reviewMatches.slice(0, 3).map((match) => {
                const home = getMatchDisplayTeam(match, 'home');
                const away = getMatchDisplayTeam(match, 'away');
                return (
                  <button type="button" key={match.id} onClick={() => onSelectMatch(match.id)}>
                    <span>{home.shortName[language] || home.name[language]}</span>
                    <b>{getScore(match)}</b>
                    <span>{away.shortName[language] || away.name[language]}</span>
                  </button>
                );
              })}
              {!reviewMatches.length && (
                <p>{language === 'zh' ? '暂无已结算赛果' : 'No settled results'}</p>
              )}
            </div>
          </section>
        </aside>
      </section>
    </div>
  );
}

import React, { useMemo } from 'react';
import {
  Activity,
  ArrowRight,
  CalendarDays,
  Flag,
  ListChecks,
  ShieldCheck,
  Sparkles,
  Target,
  Trophy
} from 'lucide-react';
import { useApp } from '../context/AppContextCore';
import type { Match } from '../services/mockData';
import { getPredictionTipDisplay, getSportteryPoolRows } from '../services/bettingDisplay';
import { getLeagueById, getTeamById } from '../services/entities';
import {
  getBestPrediction,
  getDaysUntilWorldCup,
  getMatchTrust,
  getWorldCupGroupForecasts,
  getWorldCupKnockoutForecast,
  getWorldCupProjectedQualifiers,
  getWorldCupContenders,
  getWorldCupRecentResults,
  getWorldCupUpsetRadar,
  getWorldCupWatchMatches,
  WORLD_CUP_FORECAST_MODEL,
  WORLD_CUP_KNOCKOUT_ROUNDS,
  WORLD_CUP_CONTENT_LANES,
  WORLD_CUP_OFFICIAL,
  WORLD_CUP_PIPELINE_CARDS,
  WORLD_CUP_STAGE_CARDS,
  type WorldCupTeamSeed
} from '../services/worldCupData';
import { TeamBadge } from '../components/TeamBadge';

interface WorldCupProps {
  onSelectMatch: (matchId: string) => void;
}

const formatDateTime = (isoTime: string, language: 'zh' | 'en') => {
  return new Date(isoTime).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  });
};

const getStatusText = (match: Match, language: 'zh' | 'en') => {
  if (match.status === 'FINISHED') {
    const score = Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)
      ? ` ${match.scoreHome}:${match.scoreAway}`
      : '';
    return language === 'zh' ? `完赛${score}` : `Finished${score}`;
  }
  if (match.status === 'LIVE') {
    const score = Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)
      ? ` ${match.scoreHome}:${match.scoreAway}`
      : '';
    return language === 'zh' ? `进行中${score}` : `Live${score}`;
  }
  return language === 'zh' ? '待开赛' : 'Scheduled';
};

const getTopLean = (matches: Match[], language: 'zh' | 'en') => {
  const scored = matches
    .map((match) => ({ match, prediction: getBestPrediction(match), trust: getMatchTrust(match) }))
    .filter((item) => item.prediction && item.trust > 0)
    .sort((a, b) => b.trust - a.trust);

  const top = scored[0];
  if (!top?.prediction) return language === 'zh' ? '等待模型输出' : 'Waiting for model';

  const home = getTeamById(top.match.homeTeamId);
  const away = getTeamById(top.match.awayTeamId);
  return `${home.shortName[language]} vs ${away.shortName[language]} / ${getPredictionTipDisplay(top.prediction, language)}`;
};

const worldCupFlagCodes: Record<string, string> = {
  mexico: 'mx',
  'south-africa': 'za',
  'south-korea': 'kr',
  czechia: 'cz',
  canada: 'ca',
  switzerland: 'ch',
  qatar: 'qa',
  bosnia: 'ba',
  brazil: 'br',
  morocco: 'ma',
  haiti: 'ht',
  scotland: 'gb-sct',
  usa: 'us',
  turkey: 'tr',
  australia: 'au',
  paraguay: 'py',
  germany: 'de',
  curacao: 'cw',
  'ivory-coast': 'ci',
  ecuador: 'ec',
  netherlands: 'nl',
  japan: 'jp',
  sweden: 'se',
  tunisia: 'tn',
  belgium: 'be',
  egypt: 'eg',
  iran: 'ir',
  'new-zealand': 'nz',
  spain: 'es',
  'cape-verde': 'cv',
  'saudi-arabia': 'sa',
  uruguay: 'uy',
  france: 'fr',
  senegal: 'sn',
  norway: 'no',
  iraq: 'iq',
  argentina: 'ar',
  algeria: 'dz',
  austria: 'at',
  jordan: 'jo',
  portugal: 'pt',
  uzbekistan: 'uz',
  colombia: 'co',
  'dr-congo': 'cd',
  england: 'gb-eng',
  croatia: 'hr',
  ghana: 'gh',
  panama: 'pa'
};

const getFlagLabel = (code: string) => {
  if (code === 'gb-eng') return 'ENG';
  if (code === 'gb-sct') return 'SCO';
  return code.toUpperCase();
};

const WorldCupFlag = ({ team }: { team: Pick<WorldCupTeamSeed, 'id' | 'flag' | 'name'> }) => {
  const code = worldCupFlagCodes[team.id];
  const label = code ? getFlagLabel(code) : team.flag;
  const customFlagClass = team.id === 'morocco' ? 'is-morocco' : '';

  return (
    <span className={`worldcup-team-flag ${customFlagClass}`.trim()} title={team.name.zh}>
      <b>{label}</b>
      {code && !customFlagClass && (
        <img
          src={`https://flagcdn.com/${code}.svg`}
          alt=""
          loading="lazy"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      )}
    </span>
  );
};

export const WorldCup: React.FC<WorldCupProps> = ({ onSelectMatch }) => {
  const { language, matches, dataSync } = useApp();
  const watchMatches = useMemo(() => getWorldCupWatchMatches(matches, 6), [matches]);
  const contenders = useMemo(() => getWorldCupContenders(matches, 6), [matches]);
  const upsetRadar = useMemo(() => getWorldCupUpsetRadar(matches, 5), [matches]);
  const recentResults = useMemo(() => getWorldCupRecentResults(matches, 4), [matches]);
  const groupForecasts = useMemo(() => getWorldCupGroupForecasts(), []);
  const projectedQualifiers = useMemo(() => getWorldCupProjectedQualifiers(groupForecasts), [groupForecasts]);
  const knockoutForecast = useMemo(() => getWorldCupKnockoutForecast(groupForecasts), [groupForecasts]);
  const daysLeft = getDaysUntilWorldCup();
  const activeCount = watchMatches.filter((match) => match.status !== 'FINISHED').length;
  const averageTrust = Math.round(
    watchMatches.reduce((sum, match) => sum + getMatchTrust(match), 0) / Math.max(1, watchMatches.length)
  );

  const copy = {
    kicker: { zh: '世界杯专题', en: 'World Cup Desk' },
    title: { zh: '2026 世界杯专栏', en: 'World Cup 2026 Desk' },
    subtitle: {
      zh: '小组赛预测、32 强晋级路径、淘汰赛轮次、争冠层级和竞彩观察场次集中展示；实时 SP 上线后自动进入单场模型。',
      en: 'Group forecasts, Round-of-32 routes, knockout rounds, title tiers and Sporttery watch matches in one place; live SP joins match models when available.'
    },
    host: { zh: '举办地', en: 'Host' },
    countdown: { zh: '距开赛', en: 'Kickoff in' },
    days: { zh: '天', en: 'days' },
    teams: { zh: '参赛队', en: 'Teams' },
    matches: { zh: '总场次', en: 'Matches' },
    venues: { zh: '举办城市球场', en: 'Host venues' },
    stageTitle: { zh: '赛制与晋级路径', en: 'Format and Route' },
    groupTitle: { zh: '小组赛预测', en: 'Group Forecast' },
    groupSubtitle: {
      zh: '当前采用 12 组联动模拟：FIFA 排名强度、东道主加成、新军降权和小组第三全局竞争一起计算；中国竞彩网世界杯 SP 上线后，单场赔率会自动并入模型。',
      en: 'Uses a 12-group linked simulation: FIFA rank strength, host boost, debutant adjustment and global best-third competition are calculated together. Sporttery World Cup SP will merge once available.'
    },
    baseline: { zh: '联动模拟版', en: 'Linked simulation' },
    modelMethod: { zh: '计算说明', en: 'Method' },
    rank: { zh: '排名', en: 'Rank' },
    points: { zh: '预计积分', en: 'Projected pts' },
    advance: { zh: '总晋级', en: 'Advance' },
    direct: { zh: '前二直出', en: 'Top-two' },
    thirdSlot: { zh: '第三补位', en: 'Best-third' },
    eliminated: { zh: '出局', en: 'Out' },
    winGroup: { zh: '头名', en: 'Win group' },
    bestThird: { zh: '最佳第三候选', en: 'Best third candidates' },
    bestThirdNote: {
      zh: '显示第三补位概率：先在小组内拿第三，再和其他 11 个小组第三争 8 个名额，不等同于总晋级率。',
      en: 'Shows best-third slot probability only: finish third first, then compete with the other 11 third-place teams for eight slots. It is not total advance probability.'
    },
    knockoutTitle: { zh: '淘汰赛路径预测', en: 'Knockout Route Forecast' },
    knockoutSubtitle: {
      zh: '32 强路径先按小组基准预测生成，后续会随官方赛程、SP 快照、伤停与赛果自动滚动更新。',
      en: 'The Round-of-32 route starts from group baselines, then rolls with official fixtures, SP snapshots, injuries and results.'
    },
    routeTitle: { zh: '争冠路径池', en: 'Title Route Pool' },
    champion: { zh: '夺冠', en: 'Champion' },
    round16: { zh: '16强', en: 'R16' },
    semi: { zh: '四强', en: 'Semi' },
    watchTitle: { zh: '当前推荐观察池', en: 'Current Watch Pool' },
    watchSubtitle: {
      zh: '优先展示中国竞彩网同步到的世界杯、世预赛、国际赛相关场次；没有世界杯正赛时，用国际赛作为赛前模型校准样本。',
      en: 'Prioritizes Sporttery World Cup, qualifier and international fixtures; before the tournament, internationals help model calibration.'
    },
    noWatch: { zh: '当前暂无世界杯相关赛程，等待下一次官方数据同步。', en: 'No World Cup-related fixtures yet. Waiting for the next official sync.' },
    recentTitle: { zh: '近期复盘入口', en: 'Recent Review' },
    recentEmpty: { zh: '历史库暂无相关完赛记录。', en: 'No settled related records yet.' },
    pipelineTitle: { zh: '预测系统', en: 'Forecast System' },
    contenderTitle: { zh: '冠军候选观察', en: 'Contender Watch' },
    contenderSubtitle: {
      zh: '不是提前断言冠军，而是把当前国际赛/世界杯相关场次里市场支持、模型可信和走势更强的球队提出来跟踪。',
      en: 'Not a champion call yet. This ranks teams from current World Cup-related fixtures by market support, model trust and movement.'
    },
    contenderEmpty: { zh: '等待更多官方赛程与 SP 快照。', en: 'Waiting for more official fixtures and SP snapshots.' },
    radarTitle: { zh: '冷门雷达', en: 'Upset Radar' },
    radarSubtitle: {
      zh: '专门找热门过热、让球拉扯、弱势方 SP 较高但仍有复核价值的场次。',
      en: 'Tracks overheated favourites, handicap tension and higher-SP underdogs worth review.'
    },
    radarEmpty: { zh: '当前没有明显冷门观察点。', en: 'No clear upset watch points right now.' },
    contentTitle: { zh: '内容升级路线', en: 'Content Roadmap' },
    sync: { zh: '数据同步', en: 'Data Sync' },
    active: { zh: '观察场次', en: 'Watch matches' },
    trust: { zh: '平均可信', en: 'Average trust' },
    topLean: { zh: '最高优先级', en: 'Top priority' },
    updated: { zh: '上次检查', en: 'Last checked' },
    view: { zh: '进入分析', en: 'Open analysis' },
    odds: { zh: '竞彩 SP', en: 'Sporttery SP' },
    support: { zh: '去水支持率', en: 'No-vig support' },
    model: { zh: '模型倾向', en: 'Model lean' },
    review: { zh: '查看复盘', en: 'Review' }
  };

  const t = (key: keyof typeof copy) => copy[key][language];

  return (
    <div className="worldcup-page">
      <section className="worldcup-hero-panel">
        <div className="worldcup-hero-copy">
          <span className="worldcup-kicker">
            <Trophy size={15} />
            {t('kicker')}
          </span>
          <h1>{t('title')}</h1>
          <p>{t('subtitle')}</p>
          <div className="worldcup-hero-meta">
            <span>{t('host')}：{WORLD_CUP_OFFICIAL.host[language]}</span>
            <span>{WORLD_CUP_OFFICIAL.startDate} - {WORLD_CUP_OFFICIAL.finalDate}</span>
          </div>
        </div>
        <div className="worldcup-countdown-card">
          <span>{t('countdown')}</span>
          <strong>{daysLeft}</strong>
          <small>{t('days')}</small>
        </div>
      </section>

      <section className="worldcup-kpi-grid" aria-label="World Cup summary">
        <article>
          <Flag size={18} />
          <span>{t('teams')}</span>
          <strong>{WORLD_CUP_OFFICIAL.teams}</strong>
        </article>
        <article>
          <CalendarDays size={18} />
          <span>{t('matches')}</span>
          <strong>{WORLD_CUP_OFFICIAL.matches}</strong>
        </article>
        <article>
          <ShieldCheck size={18} />
          <span>{t('active')}</span>
          <strong>{activeCount}</strong>
        </article>
        <article>
          <Activity size={18} />
          <span>{t('trust')}</span>
          <strong>{averageTrust ? `${averageTrust}%` : '--'}</strong>
        </article>
      </section>

      <section className="worldcup-section">
        <div className="worldcup-section-head">
          <div>
            <span className="worldcup-kicker">
              <ListChecks size={15} />
              {t('groupTitle')}
            </span>
            <p>{t('groupSubtitle')}</p>
          </div>
          <span className="worldcup-sync-pill">{t('baseline')} · {WORLD_CUP_FORECAST_MODEL.simulations.toLocaleString()}</span>
        </div>

        <div className="worldcup-model-note">
          <strong>{t('modelMethod')}</strong>
          <p>{WORLD_CUP_FORECAST_MODEL[language]}</p>
          <span>{WORLD_CUP_FORECAST_MODEL.version}</span>
        </div>

        <div className="worldcup-group-grid">
          {groupForecasts.map((group) => (
            <article key={group.id} className="worldcup-group-card">
              <header>
                <span>Group {group.id}</span>
                <strong>{group.dates[language]}</strong>
              </header>
              <p>{group.headline[language]}</p>
              <div className="worldcup-group-team-list">
                {group.teams.map((team) => (
                  <div key={team.id} className="worldcup-group-team-row">
                    <WorldCupFlag team={team} />
                    <span className="worldcup-team-copy">
                      <strong>{team.name[language]}</strong>
                      <small>
                        FIFA {team.fifaRank} · {t('points')} {team.projectedPoints} · {t('winGroup')} {team.groupWinProbability}%
                      </small>
                      <em>{team.routeLabel[language]}</em>
                    </span>
                    <span className="worldcup-team-prob">
                      <b>{team.advanceProbability}%</b>
                      <small>{t('advance')}</small>
                    </span>
                    <span className="worldcup-team-split">
                      <small>{t('direct')} {team.directAdvanceProbability}%</small>
                      <small>{t('thirdSlot')} {team.bestThirdProbability}%</small>
                      <small>{t('eliminated')} {team.eliminationProbability}%</small>
                    </span>
                    <span className="worldcup-team-meter" style={{ '--advance': `${team.advanceProbability}%` } as React.CSSProperties}>
                      <span />
                    </span>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>

        <div className="worldcup-third-lane">
          <span>{t('bestThird')}</span>
          <small className="worldcup-third-note">{t('bestThirdNote')}</small>
          <div>
            {projectedQualifiers.bestThird.map((team) => (
              <strong key={team.id}>
                <WorldCupFlag team={team} />
                {team.shortName[language]} <small>{team.bestThirdProbability}%</small>
              </strong>
            ))}
          </div>
        </div>
      </section>

      <section className="worldcup-knockout-grid">
        <div className="worldcup-section">
          <div className="worldcup-section-head">
            <div>
              <span className="worldcup-kicker">
                <Trophy size={15} />
                {t('knockoutTitle')}
              </span>
              <p>{t('knockoutSubtitle')}</p>
            </div>
          </div>
          <div className="worldcup-round-list">
            {WORLD_CUP_KNOCKOUT_ROUNDS.map((round) => (
              <article key={round.id}>
                <span>{round.dates[language]}</span>
                <strong>{round.title[language]}</strong>
                <small>{round.matches} {language === 'zh' ? '场' : 'matches'}</small>
                <p>{round.detail[language]}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="worldcup-section">
          <div className="worldcup-section-head">
            <div>
              <span className="worldcup-kicker">
                <ShieldCheck size={15} />
                {t('routeTitle')}
              </span>
            </div>
          </div>
          <div className="worldcup-route-list">
            {knockoutForecast.slice(0, 10).map((item) => (
              <article key={item.team.id}>
                <WorldCupFlag team={item.team} />
                <span className="worldcup-route-copy">
                  <strong>{item.team.name[language]}</strong>
                  <small>{item.tier[language]} · Group {item.team.groupId}</small>
                </span>
                <span className="worldcup-route-probs">
                  <b>{item.champion}%</b>
                  <small>{t('champion')}</small>
                </span>
                <div className="worldcup-route-bars">
                  <span>{t('round16')} {item.round16}%</span>
                  <span>{t('semi')} {item.semiFinal}%</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="worldcup-scout-grid">
        <div className="worldcup-section">
          <div className="worldcup-section-head">
            <div>
              <span className="worldcup-kicker">
                <Trophy size={15} />
                {t('contenderTitle')}
              </span>
              <p>{t('contenderSubtitle')}</p>
            </div>
          </div>

          {contenders.length === 0 ? (
            <div className="worldcup-empty">{t('contenderEmpty')}</div>
          ) : (
            <div className="worldcup-contender-list">
              {contenders.map((item) => {
                const team = getTeamById(item.teamId);
                const opponent = getTeamById(item.opponentId);

                return (
                  <button key={`${item.teamId}_${item.matchId}`} type="button" className="worldcup-contender-card" onClick={() => onSelectMatch(item.matchId)}>
                    <span className="worldcup-contender-team">
                      <TeamBadge team={team} size="sm" />
                      <strong>{team.name[language]}</strong>
                      <small>vs {opponent.shortName[language]}</small>
                    </span>
                    <span className="worldcup-scorebar" style={{ '--score': `${item.score}%` } as React.CSSProperties}>
                      <span />
                    </span>
                    <span className="worldcup-contender-meta">
                      <b>{item.score}</b>
                      <small>SP {item.support === null ? '--' : `${item.support}%`} / {t('trust')} {item.trust || '--'}%</small>
                    </span>
                    <p>{item.reason[language]}</p>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="worldcup-section">
          <div className="worldcup-section-head">
            <div>
              <span className="worldcup-kicker">
                <Activity size={15} />
                {t('radarTitle')}
              </span>
              <p>{t('radarSubtitle')}</p>
            </div>
          </div>

          {upsetRadar.length === 0 ? (
            <div className="worldcup-empty">{t('radarEmpty')}</div>
          ) : (
            <div className="worldcup-radar-list">
              {upsetRadar.map((item) => {
                const favorite = getTeamById(item.favoriteTeamId);
                const underdog = getTeamById(item.underdogTeamId);

                return (
                  <button key={`${item.matchId}_${item.underdogTeamId}`} type="button" onClick={() => onSelectMatch(item.matchId)}>
                    <span className="worldcup-radar-score">{item.riskScore}</span>
                    <span className="worldcup-radar-copy">
                      <strong>{underdog.shortName[language]} vs {favorite.shortName[language]}</strong>
                      <small>{item.reason[language]}</small>
                    </span>
                    <ArrowRight size={13} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="worldcup-section">
        <div className="worldcup-section-head">
          <div>
            <span className="worldcup-kicker">
              <ListChecks size={15} />
              {t('stageTitle')}
            </span>
          </div>
          <span className="worldcup-sync-pill">
            {t('updated')} {dataSync.lastCheckedAt ? formatDateTime(dataSync.lastCheckedAt, language) : '--'}
          </span>
        </div>
        <div className="worldcup-stage-grid">
          {WORLD_CUP_STAGE_CARDS.map((card) => (
            <article key={card.title.en} className="worldcup-stage-card">
              <span>{card.title[language]}</span>
              <strong>{card.value[language]}</strong>
              <p>{card.detail[language]}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="worldcup-section">
        <div className="worldcup-section-head">
          <div>
            <span className="worldcup-kicker">
              <Target size={15} />
              {t('watchTitle')}
            </span>
            <p>{t('watchSubtitle')}</p>
          </div>
          <span className="worldcup-sync-pill">{t('topLean')}：{getTopLean(watchMatches, language)}</span>
        </div>

        {watchMatches.length === 0 ? (
          <div className="worldcup-empty">{t('noWatch')}</div>
        ) : (
          <div className="worldcup-match-grid">
            {watchMatches.map((match) => {
              const homeTeam = getTeamById(match.homeTeamId);
              const awayTeam = getTeamById(match.awayTeamId);
              const league = getLeagueById(match.leagueId);
              const prediction = getBestPrediction(match);
              const rows = getSportteryPoolRows(match, language);
              const firstRow = rows.find((row) => row.odds);
              const trust = getMatchTrust(match);

              return (
                <article key={match.id} className="worldcup-match-card">
                  <header>
                    <span>{match.leagueName || league.name[language]}</span>
                    <strong>{formatDateTime(match.kickoffTime, language)}</strong>
                  </header>
                  <button type="button" className="worldcup-teams-button" onClick={() => onSelectMatch(match.id)}>
                    <span>
                      <TeamBadge team={homeTeam} size="sm" />
                      {homeTeam.name[language]}
                    </span>
                    <b>VS</b>
                    <span>
                      <TeamBadge team={awayTeam} size="sm" />
                      {awayTeam.name[language]}
                    </span>
                  </button>
                  <div className="worldcup-card-lines">
                    <span>{getStatusText(match, language)}</span>
                    <span>{t('model')}：{prediction ? getPredictionTipDisplay(prediction, language) : '--'}</span>
                    <span>{t('trust')}：{trust ? `${trust}%` : '--'}</span>
                  </div>
                  {firstRow?.odds ? (
                    <div className="worldcup-odds-strip">
                      <span>{t('odds')}</span>
                      <strong>{firstRow.odds.odds1.toFixed(2)}</strong>
                      <strong>{firstRow.odds.oddsX.toFixed(2)}</strong>
                      <strong>{firstRow.odds.odds2.toFixed(2)}</strong>
                      <span>{t('support')} {firstRow.probabilities ? `${firstRow.probabilities.home}/${firstRow.probabilities.draw}/${firstRow.probabilities.away}%` : '--'}</span>
                    </div>
                  ) : (
                    <div className="worldcup-odds-strip is-empty">SP -- / -- / --</div>
                  )}
                  <button type="button" className="worldcup-card-action" onClick={() => onSelectMatch(match.id)}>
                    {t('view')}
                    <ArrowRight size={13} />
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="worldcup-two-col">
        <div className="worldcup-section">
          <div className="worldcup-section-head">
            <div>
              <span className="worldcup-kicker">
                <Sparkles size={15} />
                {t('pipelineTitle')}
              </span>
            </div>
          </div>
          <div className="worldcup-pipeline-list">
            {WORLD_CUP_PIPELINE_CARDS.map((card) => (
              <article key={card.title.en}>
                <strong>{card.title[language]}</strong>
                <span>{card.value[language]}</span>
                <p>{card.detail[language]}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="worldcup-section">
          <div className="worldcup-section-head">
            <div>
              <span className="worldcup-kicker">
                <Activity size={15} />
                {t('recentTitle')}
              </span>
            </div>
          </div>

          {recentResults.length === 0 ? (
            <div className="worldcup-empty">{t('recentEmpty')}</div>
          ) : (
            <div className="worldcup-result-list">
              {recentResults.map((match) => {
                const homeTeam = getTeamById(match.homeTeamId);
                const awayTeam = getTeamById(match.awayTeamId);

                return (
                  <button key={match.id} type="button" onClick={() => onSelectMatch(match.id)}>
                    <span>
                      {homeTeam.shortName[language]} {match.scoreHome ?? '-'} : {match.scoreAway ?? '-'} {awayTeam.shortName[language]}
                    </span>
                    <strong>{t('review')}</strong>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="worldcup-section">
        <div className="worldcup-section-head">
          <div>
            <span className="worldcup-kicker">
              <ListChecks size={15} />
              {t('contentTitle')}
            </span>
          </div>
        </div>
        <div className="worldcup-lane-grid">
          {WORLD_CUP_CONTENT_LANES.map((lane) => (
            <article key={lane.title.en} className="worldcup-lane-card">
              <span>{lane.status[language]}</span>
              <strong>{lane.title[language]}</strong>
              <ul>
                {lane.items[language].map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
};

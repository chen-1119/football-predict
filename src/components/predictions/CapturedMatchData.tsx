import { formatSourceNeutralText } from './sourceNeutralText';
import type { Match } from '../../services/mockData';
import '../../styles/captured-match-data.css';

export type SavedMatchCapture = {
  matchId: string;
  homeName: string;
  awayName: string;
  kickoffTime: string;
  predictionEligible: false;
  injuries: {
    observedAt: string;
    players: Array<{
      side: 'home' | 'away';
      name: string;
      reason: string;
      position: string | null;
      expectedReturn: string | null;
    }>;
  };
  lineup: { status: 'source_empty' | 'unverified'; observedAt: null; message: string };
  manualOdds?: {
    observedAt: string;
    rowTimeAsDisplayed: string;
    values: [string, string, string];
    method: 'manual-visual-review';
    initialValues?: [string, string, string];
    history?: Array<{ rowTimeAsDisplayed: string; values: [string, string, string] }>;
  } | null;
  manualMarkets?: Array<{
    market: 'asian-handicap' | 'totals';
    observedAt: string;
    labels: [string, string, string];
    initialValues: [string, string, string];
    currentValues: [string, string, string];
    method: 'manual-visual-review';
    interpretationConfirmed: false;
  }>;
  rankSnapshot?: { observedAt: string; homeRank: number; awayRank: number };
  teamHistory?: Array<{
    side: 'home' | 'away';
    teamName: string;
    observedAt: string;
    matches: Array<{
      dateAsDisplayed: string;
      competition: string;
      round: string;
      homeName: string;
      awayName: string;
      score: string;
      halftimeScore: string;
      corners: string;
    }>;
  }>;
  manualInjuryDetails?: {
    observedAt: string;
    method: 'manual-visual-review';
    players: Array<{ side: 'home' | 'away'; name: string; startDateAsDisplayed: string; affectedMatches: number }>;
  };
  unavailableSections?: Array<'standings' | 'recentForm' | 'headToHead' | 'schedule' | 'weather' | 'goalModel' | 'prediction'>;
};

type Language = 'zh' | 'en';

// This pure guard is shared by saved-record views; it owns no React state.
// eslint-disable-next-line react-refresh/only-export-components
export function matchesSavedCaptureIdentity(
  capture: SavedMatchCapture | null | undefined,
  match: Pick<Match, 'id' | 'homeTeamName' | 'awayTeamName' | 'kickoffTime'>
): capture is SavedMatchCapture {
  if (!capture || capture.predictionEligible !== false
    || typeof match.id !== 'string' || !match.id.trim() || capture.matchId !== match.id) return false;
  if (typeof match.homeTeamName !== 'string' || !match.homeTeamName.trim()
    || typeof match.awayTeamName !== 'string' || !match.awayTeamName.trim()) return false;
  if (capture.homeName !== match.homeTeamName || capture.awayName !== match.awayTeamName) return false;
  const captureKickoff = Date.parse(capture.kickoffTime);
  const matchKickoff = Date.parse(match.kickoffTime);
  return Number.isFinite(captureKickoff) && Number.isFinite(matchKickoff) && captureKickoff === matchKickoff;
}

const capturedTimeLabel = (value: string, language: Language) => {
  const timestamp = typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value)
    ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return language === 'zh' ? '采集时间未记录' : 'Capture time not recorded';
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZone: 'Asia/Shanghai'
  }).format(timestamp) + (language === 'zh' ? '（北京时间）' : ' (Beijing time)');
};

export function CapturedMatchData({ capture, language }: { capture: SavedMatchCapture; language: Language }) {
  if (capture.predictionEligible !== false) return null;
  const unknown = language === 'zh' ? '未公布' : 'Not announced';
  const show = (value: string | null | undefined, fallback = unknown) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    const available = normalized && !/^(?:[-–—]+|未知|不详|未公布|unknown|n\/?a|null|undefined)$/i.test(normalized);
    return formatSourceNeutralText(available ? normalized : '', language, fallback);
  };
  const groups = (['home', 'away'] as const).map(side => ({
    side,
    teamName: side === 'home' ? capture.homeName : capture.awayName,
    players: capture.injuries.players.filter(player => player.side === side)
  }));
  const manualOdds = capture.manualOdds?.method === 'manual-visual-review' ? capture.manualOdds : undefined;
  const manualMarkets = (capture.manualMarkets || []).filter(market => market.method === 'manual-visual-review'
    && market.interpretationConfirmed === false && ['asian-handicap', 'totals'].includes(market.market));
  const oddsLabels = language === 'zh' ? ['主胜', '平局', '客胜'] : ['Home win', 'Draw', 'Away win'];
  const otherSections = [
    { key: 'standings', zh: '完整积分榜', en: 'Full standings' },
    { key: 'recentForm', zh: '近期战绩', en: 'Recent form' },
    { key: 'headToHead', zh: '双方交锋', en: 'Head-to-head' },
    { key: 'schedule', zh: '赛程负荷', en: 'Schedule load' },
    { key: 'weather', zh: '天气', en: 'Weather' },
    { key: 'goalModel', zh: '基于球队数据的进球模型', en: 'Team-data goal model' },
    { key: 'prediction', zh: '正式推荐', en: 'Formal recommendation' }
  ] as const;
  const unavailableSections = otherSections.filter(section => capture.unavailableSections?.includes(section.key));
  const teamHistory = (capture.teamHistory || []).filter(team => ['home', 'away'].includes(team.side) && team.matches.length > 0);
  const manualInjuryDetails = capture.manualInjuryDetails?.method === 'manual-visual-review' ? capture.manualInjuryDetails : undefined;
  const navigation = [
    { id: 'captured-injuries-heading', zh: '伤停', en: 'Absences' },
    ...(manualInjuryDetails ? [{ id: 'captured-manual-injuries-heading', zh: '人工伤停补充', en: 'Manual absence details' }] : []),
    { id: 'captured-lineup-heading', zh: '阵容', en: 'Lineup' },
    ...(capture.rankSnapshot ? [{ id: 'captured-ranks-heading', zh: '排名', en: 'Ranks' }] : []),
    ...(teamHistory.length ? [{ id: 'captured-history-heading', zh: '历史场次', en: 'Past matches' }] : []),
    ...(manualOdds ? [{ id: 'captured-manual-odds-heading', zh: '胜平负记录', en: '1X2 records' }] : []),
    ...manualMarkets.map((market, index) => ({ id: 'captured-raw-market-' + index,
      zh: market.market === 'asian-handicap' ? '让球记录' : '进球数记录',
      en: market.market === 'asian-handicap' ? 'Handicap records' : 'Total-goal records' })),
    ...(unavailableSections.length ? [{ id: 'captured-other-data-heading', zh: '其他数据', en: 'Other data' }] : [])
  ];
  return (
    <section className="card captured-match-data" aria-labelledby="captured-match-data-heading">
      <header className="captured-match-data__header">
        <h3 id="captured-match-data-heading">{language === 'zh' ? '已采集赛前记录' : 'Saved pre-match records'}</h3>
        <p>{language === 'zh' ? '按原采集时间保存，未自动更新。人工核对项已单独标注。' : 'Saved at the original capture time; not updated automatically. Manually checked entries are labelled separately.'}</p>
      </header>
      <nav className="captured-match-data__nav" aria-label={language === 'zh' ? '已保存记录导航' : 'Saved-record navigation'}>
        {navigation.map(item => <a key={item.id} href={'#' + item.id}>{item[language]}</a>)}
      </nav>
      <section className="captured-match-data__section" aria-labelledby="captured-injuries-heading">
        <div className="captured-match-data__section-head">
          <h4 id="captured-injuries-heading">{language === 'zh' ? '伤停记录' : 'Injury and absence records'}</h4>
          <span>{show(capturedTimeLabel(capture.injuries.observedAt, language))}</span>
        </div>
        {groups.map(group => <div className="captured-match-data__team" key={group.side}>
          <h5>{group.side === 'home' ? (language === 'zh' ? '主队' : 'Home') : (language === 'zh' ? '客队' : 'Away')} · {show(group.teamName)}</h5>
          {group.players.length > 0 ? <table>
            <thead><tr>
              <th scope="col">{language === 'zh' ? '球员' : 'Player'}</th>
              <th scope="col">{language === 'zh' ? '原因' : 'Reason'}</th>
              <th scope="col">{language === 'zh' ? '位置' : 'Position'}</th>
              <th scope="col">{language === 'zh' ? '预计回归' : 'Expected return'}</th>
            </tr></thead>
            <tbody>{group.players.map((player, index) => <tr key={index}>
              <td>{show(player.name)}</td><td>{show(player.reason)}</td>
              <td>{show(player.position)}</td><td>{show(player.expectedReturn)}</td>
            </tr>)}</tbody>
          </table> : <p className="captured-match-data__muted">{language === 'zh' ? '本次未保存该队伤停条目。' : 'No absence entries for this team were saved in this capture.'}</p>}
        </div>)}
      </section>
      {manualInjuryDetails && <section className="captured-match-data__section" aria-labelledby="captured-manual-injuries-heading">
        <div className="captured-match-data__section-head">
          <h4 id="captured-manual-injuries-heading">{language === 'zh' ? '人工补充伤停记录' : 'Manually supplemented absence details'}</h4>
          <span>{show(capturedTimeLabel(manualInjuryDetails.observedAt, language))}</span>
        </div>
        <p className="captured-match-data__muted">{language === 'zh' ? '人工核对的开始日期与影响场数，作为独立补充记录保存。' : 'Manually checked start dates and affected-match counts are saved as a separate supplement.'}</p>
        <table>
          <thead><tr>
            <th scope="col">{language === 'zh' ? '球员' : 'Player'}</th>
            <th scope="col">{language === 'zh' ? '球队' : 'Team'}</th>
            <th scope="col">{language === 'zh' ? '开始日期（原标记）' : 'Start date (original label)'}</th>
            <th scope="col">{language === 'zh' ? '影响场数' : 'Affected matches'}</th>
          </tr></thead>
          <tbody>{manualInjuryDetails.players.map((player, index) => <tr key={index}>
            <td>{show(player.name)}</td><td>{show(player.side === 'home' ? capture.homeName : capture.awayName)}</td>
            <td>{formatSourceNeutralText(player.startDateAsDisplayed, language, unknown)}</td>
            <td>{show(Number.isInteger(player.affectedMatches) && player.affectedMatches >= 0 ? String(player.affectedMatches) : null)}</td>
          </tr>)}</tbody>
        </table>
      </section>}
      <section className="captured-match-data__section" aria-labelledby="captured-lineup-heading">
        <h4 id="captured-lineup-heading">{language === 'zh' ? '阵容记录' : 'Lineup record'}</h4>
        <p>{capture.lineup.status === 'source_empty'
          ? (language === 'zh' ? '采集时暂无本场阵容名单；独立采集时间未记录。' : 'No lineup for this match was available when checked; its separate capture time was not recorded.')
          : (language === 'zh' ? '未取得本场阵容记录；独立采集时间未记录。' : 'No lineup record was obtained for this match; its separate capture time was not recorded.')}</p>
        <p className="captured-match-data__muted">{show(capture.lineup.message, language === 'zh' ? '暂无名单' : 'No lineup available')}</p>
      </section>
      {capture.rankSnapshot && <section className="captured-match-data__section" aria-labelledby="captured-ranks-heading">
        <div className="captured-match-data__section-head">
          <h4 id="captured-ranks-heading">{language === 'zh' ? '采集时排名' : 'Ranks at capture'}</h4>
          <span>{show(capturedTimeLabel(capture.rankSnapshot.observedAt, language))}</span>
        </div>
        <dl className="captured-match-data__ranks">
          {(['home', 'away'] as const).map(side => {
            const rank = side === 'home' ? capture.rankSnapshot?.homeRank : capture.rankSnapshot?.awayRank;
            return <div key={side}>
              <dt>{side === 'home' ? (language === 'zh' ? '主队' : 'Home') : (language === 'zh' ? '客队' : 'Away')} · {show(side === 'home' ? capture.homeName : capture.awayName)}</dt>
              <dd>{show(Number.isInteger(rank) && Number(rank) > 0 ? String(rank) : null)}</dd>
            </div>;
          })}
        </dl>
        <p className="captured-match-data__muted">{language === 'zh' ? '仅保存双方当时的排名，非完整积分榜。' : 'Only the two teams’ ranks at that time were saved; this is not the full standings table.'}</p>
      </section>}
      {teamHistory.length > 0 && <section className="captured-match-data__section" aria-labelledby="captured-history-heading">
        <h4 id="captured-history-heading">{language === 'zh' ? '已保存历史场次' : 'Saved past matches'}</h4>
        <p className="captured-match-data__muted">{language === 'zh' ? '已保存的部分历史场次，非完整近期战绩。' : 'These are a subset of saved past matches, not a complete recent-form record.'}
          {!teamHistory.some(team => team.side === 'away') && (language === 'zh' ? '客队近期战绩未采集。' : ' Away-team recent form was not collected.')}</p>
        {teamHistory.map((team, index) => <div className="captured-match-data__team" key={team.side + index}>
          <div className="captured-match-data__section-head">
            <h5 id={'captured-history-team-' + index}>{show(team.teamName)}</h5>
            <span>{show(capturedTimeLabel(team.observedAt, language))}</span>
          </div>
          <div className="captured-match-data__table-scroll" tabIndex={0} role="region" aria-labelledby={'captured-history-team-' + index}>
            <table className="captured-match-data__history-table">
              <thead><tr>
                <th scope="col">{language === 'zh' ? '原日期' : 'Original date'}</th>
                <th scope="col">{language === 'zh' ? '赛事 / 轮次' : 'Competition / round'}</th>
                <th scope="col">{language === 'zh' ? '对阵' : 'Fixture'}</th>
                <th scope="col">{language === 'zh' ? '全场 / 半场' : 'Full / half time'}</th>
                <th scope="col">{language === 'zh' ? '角球' : 'Corners'}</th>
              </tr></thead>
              <tbody>{team.matches.map((row, rowIndex) => <tr key={rowIndex}>
                <td>{formatSourceNeutralText(row.dateAsDisplayed, language, unknown)}</td>
                <td>{show(row.competition)}<small>{show(row.round)}</small></td>
                <td>{show(row.homeName)}<small>{language === 'zh' ? '对阵' : 'vs'}</small>{show(row.awayName)}</td>
                <td>{show(row.score)}<small>{show(row.halftimeScore)}</small></td>
                <td>{show(row.corners)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>)}
      </section>}
      {manualOdds && <section className="captured-match-data__section" aria-labelledby="captured-manual-odds-heading">
        <div className="captured-match-data__section-head">
          <h4 id="captured-manual-odds-heading">{language === 'zh' ? '人工核对记录 · 非竞彩 SP' : 'Manually checked odds · not Sporttery SP'}</h4>
          <span>{show(capturedTimeLabel(manualOdds.observedAt, language))}</span>
        </div>
        <h5>{language === 'zh' ? '当时记录' : 'Record at capture'}</h5>
        <div className="captured-match-data__odds">
          {manualOdds.values.map((value, index) => <div key={index}>
            <span>{oddsLabels[index]}</span>
            <strong>{show(value)}</strong>
          </div>)}
        </div>
        <p className="captured-match-data__muted">{language === 'zh' ? '原行时间标记：' : 'Original row time label: '}{formatSourceNeutralText(manualOdds.rowTimeAsDisplayed, language, unknown)}</p>
        {manualOdds.initialValues && <>
          <h5>{language === 'zh' ? '初始记录' : 'Initial record'}</h5>
          <div className="captured-match-data__odds is-initial">
            {manualOdds.initialValues.map((value, index) => <div key={index}>
              <span>{oddsLabels[index]}</span><strong>{show(value)}</strong>
            </div>)}
          </div>
        </>}
        {Boolean(manualOdds.history?.length) && <div className="captured-match-data__history">
          <h5>{language === 'zh' ? '历史行记录' : 'Historical row records'}</h5>
          <table className="captured-match-data__record-table">
            <thead><tr>
              <th scope="col">{language === 'zh' ? '原行时间标记' : 'Original row time label'}</th>
              {oddsLabels.map(label => <th scope="col" key={label}>{label}</th>)}
            </tr></thead>
            <tbody>{manualOdds.history?.map((row, index) => <tr key={index}>
              <td>{formatSourceNeutralText(row.rowTimeAsDisplayed, language, unknown)}</td>
              {row.values.map((value, valueIndex) => <td key={valueIndex}>{show(value)}</td>)}
            </tr>)}</tbody>
          </table>
          <p className="captured-match-data__muted">{language === 'zh' ? '历史行按上述采集时间一并保存；原行时间标记未换算，不代表多轮自动采集。' : 'These historical rows were saved together at the capture time above. Their original time labels are not converted and do not represent repeated automatic captures.'}</p>
        </div>}
      </section>}
      {manualMarkets.map((market, index) => <section className="captured-match-data__section" key={market.market + index} aria-labelledby={'captured-raw-market-' + index}>
        <div className="captured-match-data__section-head">
          <h4 id={'captured-raw-market-' + index}>{market.market === 'asian-handicap'
            ? (language === 'zh' ? '让球原始记录' : 'Raw handicap record')
            : (language === 'zh' ? '进球数原始记录' : 'Raw total-goals record')}</h4>
          <span>{show(capturedTimeLabel(market.observedAt, language))}</span>
        </div>
        <p className="captured-match-data__muted">{market.market === 'asian-handicap'
          ? (language === 'zh' ? '人工核对；盘口方向与水位格式待确认。保留原值，不作为竞彩让球 SP，不做换算。' : 'Manually checked; the handicap direction and price format are not yet confirmed. Original values are retained without conversion and are not Sporttery handicap SP.')
          : (language === 'zh' ? '人工核对；水位格式待确认，按大 / 盘口 / 小保留原值。' : 'Manually checked; the price format is not yet confirmed. Original values are retained in over / line / under order.')}</p>
        <table className="captured-match-data__record-table">
          <thead><tr>
            <th scope="col">{language === 'zh' ? '记录' : 'Record'}</th>
            {market.labels.map((label, labelIndex) => <th scope="col" key={labelIndex}>{show(label)}</th>)}
          </tr></thead>
          <tbody>
            <tr><th scope="row">{language === 'zh' ? '初始记录' : 'Initial record'}</th>{market.initialValues.map((value, valueIndex) => <td key={valueIndex}>{show(value)}</td>)}</tr>
            <tr><th scope="row">{language === 'zh' ? '当时值' : 'At capture'}</th>{market.currentValues.map((value, valueIndex) => <td key={valueIndex}>{show(value)}</td>)}</tr>
          </tbody>
        </table>
      </section>)}
      {unavailableSections.length > 0 && <section className="captured-match-data__section" aria-labelledby="captured-other-data-heading">
        <h4 id="captured-other-data-heading">{language === 'zh' ? '其他数据' : 'Other data'}</h4>
        <dl className="captured-match-data__availability">
          {unavailableSections.map(section => <div key={section.key}>
            <dt>{section[language]}</dt>
            <dd>{section.key === 'goalModel' || section.key === 'prediction'
              ? (language === 'zh' ? '尚未生成' : 'Not generated')
              : (language === 'zh' ? '本次尚未采集' : 'Not collected in this capture')}</dd>
          </div>)}
        </dl>
      </section>}
    </section>
  );
}

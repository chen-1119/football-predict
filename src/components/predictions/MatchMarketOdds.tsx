import { getSportteryPoolRows } from '../../services/bettingDisplay';
import type { Match } from '../../services/mockData';
import { matchesSavedCaptureIdentity, type SavedMatchCapture } from './CapturedMatchData';

export function MatchMarketOdds({ match, language, capturedData }: { match: Match; language: 'zh' | 'en'; capturedData?: SavedMatchCapture }) {
  const pools = getSportteryPoolRows(match, language);
  const candidate = capturedData && matchesSavedCaptureIdentity(capturedData, match) ? capturedData.manualOdds : null;
  const observedAt = candidate && /(?:z|[+-]\d{2}:\d{2})$/i.test(candidate.observedAt) ? Date.parse(candidate.observedAt) : NaN;
  const manualOdds = !pools.find(pool => pool.poolCode === 'HAD')?.odds
    && candidate?.method === 'manual-visual-review' && Number.isFinite(observedAt)
    && observedAt < Date.parse(match.kickoffTime)
    && Array.isArray(candidate.values) && candidate.values.length === 3
    && candidate.values.every(value => typeof value === 'string' && /^\d+\.\d{2}$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 1)
    ? candidate : null;
  return (
    <div className="compact-market-odds" aria-label={language === 'zh' ? '胜平负与让球胜平负赔率' : '1X2 and handicap result odds'}>
      {pools.map(pool => {
        const rawLine = String(pool.handicap ?? '').trim();
        const lineNumber = rawLine && /^[+-]?\d+(?:\.0+)?$/.test(rawLine) ? Number(rawLine) : NaN;
        const lineKnown = Number.isSafeInteger(lineNumber);
        const available = Boolean(pool.odds && (pool.poolCode === 'HAD' || lineKnown));
        const lineLabel = lineKnown ? `${lineNumber > 0 ? '+' : ''}${lineNumber}` : '--';
        const labels = pool.poolCode === 'HAD'
          ? (language === 'zh' ? ['主胜', '平局', '客胜'] : ['Home', 'Draw', 'Away'])
          : (language === 'zh' ? ['让胜', '让平', '让负'] : ['H.Home', 'H.Draw', 'H.Away']);
        return <div key={pool.poolCode} className="compact-market-odds__row" data-market-pool={pool.poolCode}>
          <div className="compact-market-odds__name">
            <strong>{pool.poolCode === 'HAD' ? (language === 'zh' ? '胜平负' : '1X2') : (language === 'zh' ? '让球胜平负' : 'Handicap')}</strong>
            <small>{pool.poolCode === 'HHAD'
              ? (lineKnown ? `${language === 'zh' ? '主队' : 'Home'} ${lineLabel}` : (language === 'zh' ? '让球未确认' : 'Line unknown'))
              : !available ? (language === 'zh' ? '暂无赔率' : 'Unavailable') : (language === 'zh' ? '不让球' : 'No handicap')}</small>
          </div>
          {(['odds1', 'oddsX', 'odds2'] as const).map((key, index) => <div className="compact-market-odds__price" key={key}>
            <span>{labels[index]}</span><strong>{available && pool.odds ? pool.odds[key].toFixed(2) : '--'}</strong>
          </div>)}
        </div>;
      })}
      {manualOdds && <div className="compact-market-odds__manual">
        <div className="compact-market-odds__row" data-market-pool="MANUAL_1X2">
          <div className="compact-market-odds__name">
            <strong>{language === 'zh' ? '胜平负记录' : 'Saved 1X2'}</strong>
            <small>{language === 'zh' ? '人工核对' : 'Manually checked'}</small>
          </div>
          {manualOdds.values.map((value, index) => <div className="compact-market-odds__price" key={index}>
            <span>{(language === 'zh' ? ['主胜', '平局', '客胜'] : ['Home', 'Draw', 'Away'])[index]}</span><strong>{value}</strong>
          </div>)}
        </div>
        <p>{language === 'zh' ? '非竞彩 SP · 采集于 ' : 'Not Sporttery SP · Captured '}{new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Shanghai'
        }).format(observedAt)}{language === 'zh' ? '（北京时间）' : ' (Beijing time)'}</p>
      </div>}
    </div>
  );
}

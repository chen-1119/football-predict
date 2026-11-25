import type { Match } from '../services/mockData';
import { legacyArchiveGap } from '../services/legacyArchiveGap';

export function LegacyArchiveGap({ match, language }: { match: Match; language: 'zh' | 'en' }) {
  const gap = legacyArchiveGap(match), record = gap.record, zh = language === 'zh';
  const finished = match.status === 'FINISHED';
  return <section className="card recommendation-overview-card" data-legacy-archive-state={gap.state}>
    <div className="recommendation-overview-panel">
      <small>{zh ? '旧版归档 · 只读核对' : 'Legacy archive · read-only'}</small>
      <h2>{record ? (zh ? '公开参考已归档，非正式推荐结算' : 'Public reference archived, not formal settlement') : (zh ? '赛前归档证据不足' : 'Pre-match archive evidence unavailable')}</h2>
      {record && <div data-legacy-reference-hash={record.contentHash}>
        <strong>{record.prediction.tipLabel?.[language] || record.prediction.tipCode}</strong>
        <p>{record.prediction.oddsPoolCode}{record.prediction.oddsPoolCode === 'HHAD' ? ` (${record.prediction.handicapLine})` : ''} · SP {record.prediction.odds > 0 ? record.prediction.odds.toFixed(2) : '—'}</p>
        <p>{zh ? '原记录时间' : 'Original recorded time'}：{record.recordedAt}</p>
      </div>}
      <p>{finished ? (zh ? `比赛已完场：${match.scoreHome ?? '—'}:${match.scoreAway ?? '—'}。` : `Finished: ${match.scoreHome ?? '—'}:${match.scoreAway ?? '—'}.`) : (zh ? '官方赛果尚待确认。' : 'Official result pending.')}</p>
      <p>{record
        ? (zh ? '仅保存有校验的赛前公开参考；未取得可用于正式推荐结算的归档与回执。参考原件保留，不计正式命中率，不再显示为后台正在结算。' : 'Only an attested pre-match public reference is available. No eligible formal settlement archive and receipt exists. The original is retained and excluded from formal hit rates; no settlement job is implied.')
        : (zh ? '没有通过校验的赛前推荐归档，不能承诺稍后自动结算。只保留赛果或待核状态，不在赛后补造方向，不计正式命中率。' : 'No verified pre-match recommendation archive is available. Automatic settlement cannot be promised. Retain only the result or pending verification; do not reconstruct picks or count formal results.')}</p>
    </div>
  </section>;
}

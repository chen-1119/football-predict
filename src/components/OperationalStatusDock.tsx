import React from 'react';
import { Activity, ChevronDown, ChevronUp, Clock3, Layers3, Trophy } from 'lucide-react';

type Language = 'zh' | 'en';

type RealtimeHealth = {
  status?: 'live' | 'publication-delayed' | 'source-stale';
  checkedAt?: string;
  source?: { observedAt?: string | null; ageSeconds?: number | null; fresh?: boolean };
  publication?: { committedAt?: string | null; ageSeconds?: number | null; fresh?: boolean; generationId?: string | null };
  current?: { count?: number; businessDates?: string[] };
  message?: { zh?: string; en?: string };
};

type FeaturedLeg = {
  matchNo?: string | null;
  homeTeamName?: string | null;
  awayTeamName?: string | null;
  pool?: 'HAD' | 'HHAD';
  handicapLine?: number;
  tipCode?: '1' | 'X' | '2';
  sp?: number;
  resultStatus?: 'PENDING' | 'WON' | 'LOST' | 'VOID';
};

type FeaturedEdition = {
  type?: '2x1' | '3x1';
  status?: 'published' | 'insufficient-qualified-pool';
  combinedSp?: number | null;
  minCombinedSp?: number;
  averageEvidence?: number | null;
  legs?: FeaturedLeg[];
  settlement?: { status?: 'UNSETTLED' | 'WON' | 'LOST' | 'VOID' };
};

type FeaturedPayload = {
  generatedAt?: string;
  today?: {
    businessDate?: string;
    state?: 'published' | 'no-qualified-combo' | 'waiting-decision-window';
    candidateCount?: number;
    decisionAt?: string | null;
    twoLeg?: FeaturedEdition | null;
    threeLeg?: FeaturedEdition | null;
  };
  stats?: {
    twoLeg?: { published?: number; settled?: number; won?: number; hitRate?: number | null };
    threeLeg?: { published?: number; settled?: number; won?: number; hitRate?: number | null };
  };
};

const STATIC_REFRESH_MS = 15_000;

const staticUrl = (file: string) => {
  const base = String(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
  return `${base}data/${file}`;
};

const fetchOptionalJson = async <T,>(file: string, signal: AbortSignal): Promise<T | null> => {
  try {
    const response = await fetch(`${staticUrl(file)}?v=${Date.now()}`, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
};

const ageLabel = (seconds: number | null | undefined, language: Language) => {
  if (!Number.isFinite(seconds)) return '--';
  const value = Number(seconds);
  if (value < 60) return language === 'zh' ? `${Math.round(value)}秒` : `${Math.round(value)}s`;
  if (value < 3600) return language === 'zh' ? `${Math.round(value / 60)}分钟` : `${Math.round(value / 60)}m`;
  return language === 'zh' ? `${(value / 3600).toFixed(1)}小时` : `${(value / 3600).toFixed(1)}h`;
};

const pickLabel = (leg: FeaturedLeg, language: Language) => {
  const had = language === 'zh'
    ? { '1': '主胜', X: '平局', '2': '客胜' }
    : { '1': 'Home', X: 'Draw', '2': 'Away' };
  const hhad = language === 'zh'
    ? { '1': '让胜', X: '让平', '2': '让负' }
    : { '1': 'H.Home', X: 'H.Draw', '2': 'H.Away' };
  const labels = leg.pool === 'HHAD' ? hhad : had;
  const value = leg.tipCode ? labels[leg.tipCode] : '--';
  if (leg.pool !== 'HHAD' || !Number.isFinite(leg.handicapLine)) return value;
  const line = Number(leg.handicapLine);
  return `${value} (${line > 0 ? '+' : ''}${line})`;
};

const EditionCard = ({ edition, type, language }: {
  edition: FeaturedEdition | null | undefined;
  type: '2x1' | '3x1';
  language: Language;
}) => {
  const title = type === '2x1' ? '2串1' : '3串1';
  const target = type === '2x1' ? 2.5 : 5;
  if (!edition || edition.status !== 'published') {
    return (
      <section className="ops-edition is-empty">
        <header><strong>{title}</strong><span>SP ≥ {target.toFixed(1)}</span></header>
        <p>{language === 'zh' ? '当前没有达到质量与 SP 门槛的组合。' : 'No combo currently clears quality and SP gates.'}</p>
      </section>
    );
  }
  return (
    <section className={`ops-edition is-${String(edition.settlement?.status || 'UNSETTLED').toLowerCase()}`}>
      <header>
        <strong>{title}</strong>
        <span className="ops-combined-sp">SP {Number(edition.combinedSp || 0).toFixed(2)}</span>
      </header>
      <div className="ops-legs">
        {(edition.legs || []).map((leg, index) => (
          <div className="ops-leg" key={`${leg.matchNo || index}-${leg.homeTeamName}-${leg.awayTeamName}`}>
            <span className="ops-leg-index">{index + 1}</span>
            <span className="ops-leg-match">
              <small>{leg.matchNo || (language === 'zh' ? '比赛' : 'Match')}</small>
              <b>{leg.homeTeamName || '--'} <i>vs</i> {leg.awayTeamName || '--'}</b>
            </span>
            <span className="ops-leg-pick">
              <b>{pickLabel(leg, language)}</b>
              <small>SP {Number(leg.sp || 0).toFixed(2)}</small>
            </span>
            <em className={`ops-leg-result is-${String(leg.resultStatus || 'PENDING').toLowerCase()}`}>
              {leg.resultStatus || 'PENDING'}
            </em>
          </div>
        ))}
      </div>
    </section>
  );
};

export const OperationalStatusDock: React.FC = () => {
  const [health, setHealth] = React.useState<RealtimeHealth | null>(null);
  const [featured, setFeatured] = React.useState<FeaturedPayload | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const language: Language = typeof document !== 'undefined' && document.documentElement.lang.startsWith('en') ? 'en' : 'zh';

  React.useEffect(() => {
    let alive = true;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      const [nextHealth, nextFeatured] = await Promise.all([
        fetchOptionalJson<RealtimeHealth>('realtime-health.json', controller.signal),
        fetchOptionalJson<FeaturedPayload>('daily-featured-combos.json', controller.signal),
      ]);
      if (!alive) return;
      if (nextHealth) setHealth(nextHealth);
      if (nextFeatured) setFeatured(nextFeatured);
    };
    void refresh();
    const timer = window.setInterval(refresh, STATIC_REFRESH_MS);
    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, []);

  const status = health?.status || 'source-stale';
  const statusLabel = status === 'live'
    ? (language === 'zh' ? '实时正常' : 'Live')
    : status === 'publication-delayed'
      ? (language === 'zh' ? '发布延迟' : 'Publish delayed')
      : (language === 'zh' ? '数据滞后' : 'Data stale');
  const today = featured?.today;
  const publishedCount = [today?.twoLeg, today?.threeLeg].filter((row) => row?.status === 'published').length;

  return (
    <aside className={`ops-dock is-${status} ${expanded ? 'is-expanded' : ''}`} aria-label={language === 'zh' ? '实时状态与每日精选' : 'Realtime status and daily featured combos'}>
      <button type="button" className="ops-dock-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="ops-live-dot" aria-hidden="true" />
        <span className="ops-summary-copy">
          <strong>{statusLabel}</strong>
          <small>{language === 'zh' ? `源 ${ageLabel(health?.source?.ageSeconds, language)} · 发布 ${ageLabel(health?.publication?.ageSeconds, language)}` : `source ${ageLabel(health?.source?.ageSeconds, language)} · publish ${ageLabel(health?.publication?.ageSeconds, language)}`}</small>
        </span>
        <span className="ops-summary-featured"><Trophy size={14} /> {publishedCount}/2</span>
        {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>

      {expanded && (
        <div className="ops-dock-body">
          <section className="ops-health-grid">
            <div><Activity size={16} /><span>{language === 'zh' ? '源数据' : 'Source'}<b>{ageLabel(health?.source?.ageSeconds, language)}</b></span></div>
            <div><Layers3 size={16} /><span>{language === 'zh' ? '页面发布' : 'Publication'}<b>{ageLabel(health?.publication?.ageSeconds, language)}</b></span></div>
            <div><Clock3 size={16} /><span>{language === 'zh' ? '当前场次' : 'Fixtures'}<b>{health?.current?.count ?? '--'}</b></span></div>
          </section>

          <div className="ops-featured-head">
            <div><small>{language === 'zh' ? '每日精选' : 'Daily featured'}</small><strong>{today?.businessDate || '--'}</strong></div>
            <span>{today?.state === 'waiting-decision-window' ? (language === 'zh' ? '等待冻结窗口' : 'Waiting') : `${today?.candidateCount ?? 0} ${language === 'zh' ? '个候选' : 'candidates'}`}</span>
          </div>

          <EditionCard edition={today?.twoLeg} type="2x1" language={language} />
          <EditionCard edition={today?.threeLeg} type="3x1" language={language} />

          <footer className="ops-review-line">
            <span>{language === 'zh' ? '2串1命中' : '2-leg hit'} <b>{featured?.stats?.twoLeg?.hitRate ?? '--'}{featured?.stats?.twoLeg?.hitRate != null ? '%' : ''}</b></span>
            <span>{language === 'zh' ? '3串1命中' : '3-leg hit'} <b>{featured?.stats?.threeLeg?.hitRate ?? '--'}{featured?.stats?.threeLeg?.hitRate != null ? '%' : ''}</b></span>
            <small>{language === 'zh' ? '仅统计已结算 WON/LOST；作废不计命中率。' : 'Hit rate uses settled WON/LOST only; voids are excluded.'}</small>
          </footer>
        </div>
      )}
    </aside>
  );
};

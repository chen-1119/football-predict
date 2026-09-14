import type { Match } from '../../services/mockData';
import { quoteInstant, resolveMatchQuotes } from '../../services/marketQuotePolicy';
import type { ResolvedQuote } from '../../services/marketQuotePolicy';
import { matchesSavedCaptureIdentity, type SavedMatchCapture } from './CapturedMatchData';
import { MarketQuoteCard } from './MarketQuoteCard';

export function MatchMarketOdds({ match, language, capturedData, nowMs = Date.now() }: {
  match: Match;
  language: 'zh' | 'en';
  capturedData?: SavedMatchCapture;
  nowMs?: number;
}) {
  const kickoff = quoteInstant(match.kickoffTime);
  const upcoming = match.status === 'SCHEDULED' && kickoff !== null && kickoff > nowMs;
  // Current display may choose a fresh reference over a stale official quote, but the
  // selected recommendation's SP and all archived recommendation records stay untouched.
  const quotes = resolveMatchQuotes(match, { nowMs, preferFresh: upcoming,
    maxAgeMs: upcoming && kickoff - nowMs <= 2 * 3600_000 ? 10 * 60_000 : 60 * 60_000 });
  const candidate = capturedData && matchesSavedCaptureIdentity(capturedData, match) ? capturedData.manualOdds : null;
  const observedAt = quoteInstant(candidate?.observedAt);
  const manual = !quotes.had && candidate?.method === 'manual-visual-review' && observedAt !== null
    && kickoff !== null && observedAt < kickoff && observedAt <= nowMs
    && Array.isArray(candidate.values) && candidate.values.length === 3
    && candidate.values.every(value => typeof value === 'string' && /^\d+\.\d{2}$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 1)
    ? candidate : null;
  const manualQuote: ResolvedQuote | undefined = manual && observedAt !== null ? {
    candidateId: 'manual', pool: 'HAD', provenance: 'reference', source: 'manual-visual-review',
    freshness: nowMs - observedAt > 10 * 60_000 ? 'stale' : 'fresh', updatedAt: new Date(observedAt).toISOString(),
    odds: { odds1: Number(manual.values[0]), oddsX: Number(manual.values[1]), odds2: Number(manual.values[2]) }
  } : undefined;
  const had = quotes.had || manualQuote;
  return <div className="compact-market-odds market-quote-stack" aria-label={language === 'zh' ? '比赛赔率与采集来源' : 'Match quotes and their sources'}>
    <MarketQuoteCard pool="HAD" quote={had} language={language} archived={!upcoming} />
    {had ? <details className="market-quote-disclosure">
      <summary><span>{language === 'zh' ? '让球胜平负' : 'Handicap result'}</span><span>{language === 'zh' ? '查看盘口' : 'View market'}</span></summary>
      <MarketQuoteCard pool="HHAD" quote={quotes.hhad} language={language} archived={!upcoming} />
    </details> : <MarketQuoteCard pool="HHAD" quote={quotes.hhad} language={language} archived={!upcoming} />}
  </div>;
}

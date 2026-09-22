import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import '../../styles/matchday-cards.css';

type MatchSummaryTone = 'formal' | 'analysis' | 'archive' | 'fixture';
interface MatchSummaryRowProps {
  eventKey: string;
  tone: MatchSummaryTone;
  timeLabel: string;
  teamsLabel: string;
  marketOddsLabel: string;
  pickLabel: string;
  oddsLabel: string;
  resultLabel: string;
  detailsLabel: string;
  detailsAriaLabel?: string;
  time: ReactNode;
  teams: ReactNode;
  marketOdds: ReactNode;
  pick: ReactNode;
  odds: ReactNode;
  result: ReactNode;
  onOpen: () => void;
  follow?: ReactNode;
}

/** Layout only: route keys, selected SP, review outcome and frozen picks remain caller-owned. */
export const MatchSummaryRow = ({ eventKey, tone, timeLabel, teamsLabel, marketOddsLabel,
  pickLabel, oddsLabel, resultLabel, detailsLabel, detailsAriaLabel, time, teams,
  marketOdds, pick, odds, result, onOpen, follow }: MatchSummaryRowProps) => (
  <article data-match-event-key={eventKey} data-selection-tone={tone} aria-label={detailsAriaLabel}
    className={`match-row predictions-v4__match-row compact-match-row matchday-card is-${tone}`}>
    <div className="match-time-cell predictions-v4__match-slot is-time" data-label={timeLabel}>
      <span className="predictions-v4__slot-label">{timeLabel}</span>{time}
    </div>
    <div className="match-teams-cell predictions-v4__match-slot is-teams" data-label={teamsLabel}>
      <span className="predictions-v4__slot-label">{teamsLabel}</span>{teams}
    </div>
    <div className="predictions-v4__match-slot is-market-odds" data-label={marketOddsLabel}>
      <span className="predictions-v4__slot-label">{marketOddsLabel}</span>{marketOdds}
    </div>
    <div className="predictions-v4__match-slot is-pick" data-label={pickLabel}>
      <span className="predictions-v4__slot-label">{pickLabel}</span>{pick}
    </div>
    <div className="predictions-v4__match-slot is-sp" data-label={oddsLabel}>
      <span className="predictions-v4__slot-label">{oddsLabel}</span>{odds}
    </div>
    <div className="predictions-v4__match-slot is-result" data-label={resultLabel}>
      <span className="predictions-v4__slot-label">{resultLabel}</span>{result}
    </div>
    <div className="match-action-cell predictions-v4__match-action">
      {follow}
      <button type="button" className="details-button" aria-label={detailsAriaLabel || detailsLabel}
        onClick={event => { event.stopPropagation(); onOpen(); }}>
        <span>{detailsLabel}</span><ArrowRight size={16} aria-hidden="true" />
      </button>
    </div>
  </article>
);

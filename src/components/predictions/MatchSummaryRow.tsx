import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';

type MatchSummaryTone = 'formal' | 'analysis' | 'archive' | 'fixture';

interface MatchSummaryRowProps {
  eventKey: string;
  tone: MatchSummaryTone;
  isAnalysisView: boolean;
  timeLabel: string;
  teamsLabel: string;
  oddsLabel: string;
  decisionLabel: string;
  detailsLabel: string;
  detailsAriaLabel?: string;
  time: ReactNode;
  teams: ReactNode;
  odds: ReactNode;
  decision?: ReactNode;
  onOpen: () => void;
}

export const MatchSummaryRow = ({
  eventKey,
  tone,
  isAnalysisView,
  timeLabel,
  teamsLabel,
  oddsLabel,
  decisionLabel,
  detailsLabel,
  detailsAriaLabel,
  time,
  teams,
  odds,
  decision,
  onOpen
}: MatchSummaryRowProps) => {
  const showDecision = isAnalysisView || decision !== undefined;

  return (
  <article
    data-match-event-key={eventKey}
    data-selection-tone={tone}
    data-has-decision={showDecision ? 'true' : 'false'}
    className={`match-row predictions-v4__match-row is-${tone} ${showDecision ? 'has-decision' : ''}`}
  >
    <div className="match-time-cell predictions-v4__match-slot is-time" data-label={timeLabel}>
      <span className="predictions-v4__slot-label">{timeLabel}</span>
      {time}
    </div>
    <div className="match-teams-cell predictions-v4__match-slot is-teams" data-label={teamsLabel}>
      <span className="predictions-v4__slot-label">{teamsLabel}</span>
      {teams}
    </div>
    <div className="match-odds-cell predictions-v4__match-slot is-odds" data-label={oddsLabel}>
      <span className="predictions-v4__slot-label">{oddsLabel}</span>
      {odds}
    </div>
    {showDecision && (
      <div className="match-decision-cell predictions-v4__match-slot is-decision" data-label={decisionLabel}>
        <span className="predictions-v4__slot-label">{decisionLabel}</span>
        {decision}
      </div>
    )}
    <div className="match-action-cell predictions-v4__match-action">
      <button
        type="button"
        className="details-button"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        aria-label={detailsAriaLabel || detailsLabel}
      >
        <span>{detailsLabel}</span>
        <ArrowRight size={14} aria-hidden="true" />
      </button>
    </div>
  </article>
  );
};

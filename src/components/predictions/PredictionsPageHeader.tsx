import type { ReactNode } from 'react';

interface PredictionsPageHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  updatedLabel: string;
  updatedAt: string;
  matchSummary: string;
  secondarySummary: string;
  status?: ReactNode;
  action?: ReactNode;
}

export const PredictionsPageHeader = ({
  eyebrow,
  title,
  description,
  updatedLabel,
  updatedAt,
  matchSummary,
  secondarySummary,
  status,
  action
}: PredictionsPageHeaderProps) => (
  <div className="predictions-v4__page-header">
    <div className="predictions-v4__heading">
      <span className="predictions-v4__eyebrow">{eyebrow}</span>
      <div className="predictions-v4__title-line">
        <h1>{title}</h1>
        {status}
      </div>
      <p>{description}</p>
    </div>
    <div className="predictions-v4__header-meta" role="status" aria-live="polite" aria-atomic="true">
      <span>{updatedLabel} {updatedAt}</span>
      <strong>{matchSummary}</strong>
      <span>{secondarySummary}</span>
      {action}
    </div>
  </div>
);

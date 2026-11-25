interface PredictionsPageHeaderProps {
  title: string;
  description: string;
  matchSummary: string;
}

export const PredictionsPageHeader = ({
  title,
  description,
  matchSummary
}: PredictionsPageHeaderProps) => (
  <div className="predictions-v4__page-header">
    <div className="predictions-v4__heading">
      <div className="predictions-v4__title-line">
        <h1>{title}</h1>
      </div>
      <p>{description}</p>
    </div>
    <div className="predictions-v4__header-meta" role="status" aria-live="polite" aria-atomic="true">
      <strong>{matchSummary}</strong>
    </div>
  </div>
);

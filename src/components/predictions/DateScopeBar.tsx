import { CalendarDays } from 'lucide-react';

interface DateOption {
  label: string;
  date: string;
  displayDate: string;
}

interface DateScopeBarProps {
  selectedDate: string;
  quickOptions: DateOption[];
  historyOptions: DateOption[];
  selectedHistoryDate: string;
  historyLabel: string;
  onSelectDate: (date: string) => void;
}

export const DateScopeBar = ({
  selectedDate,
  quickOptions,
  historyOptions,
  selectedHistoryDate,
  historyLabel,
  onSelectDate
}: DateScopeBarProps) => (
  <div className="predictions-v4__date-scope">
    <div className="date-quick-row" role="group" aria-label={historyLabel}>
      {quickOptions.map((option) => (
        <button
          key={option.date}
          type="button"
          onClick={() => onSelectDate(option.date)}
          className={`date-chip ${selectedDate === option.date ? 'active' : ''}`}
          aria-pressed={selectedDate === option.date}
          aria-current={selectedDate === option.date ? 'date' : undefined}
        >
          <span className="date-label">{option.label}</span>
          <span className="date-value">{option.displayDate}</span>
        </button>
      ))}
    </div>
    {historyOptions.length > 0 && (
      <label className={`history-date-select ${selectedHistoryDate ? 'active' : ''}`}>
        <CalendarDays size={15} aria-hidden="true" />
        <select
          aria-label={historyLabel}
          value={selectedHistoryDate}
          onChange={(event) => {
            if (event.target.value) onSelectDate(event.target.value);
          }}
        >
          <option value="">{historyLabel}</option>
          {historyOptions.map((option) => (
            <option key={option.date} value={option.date}>
              {option.label} · {option.displayDate}
            </option>
          ))}
        </select>
      </label>
    )}
  </div>
);

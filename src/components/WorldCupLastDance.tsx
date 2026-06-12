type Locale = 'zh' | 'en';

interface WorldCupLastDanceProps {
  language: Locale;
}

const posterTiles = [
  {
    value: '48',
    label: { zh: '参赛球队', en: 'Teams' }
  },
  {
    value: '104',
    label: { zh: '总场次', en: 'Matches' }
  },
  {
    value: '12',
    label: { zh: '小组路径', en: 'Groups' }
  },
  {
    value: 'SP',
    label: { zh: '赔率同步', en: 'Odds Sync' }
  }
];

export function WorldCupLastDance({ language }: WorldCupLastDanceProps) {
  const copy = {
    eyebrow: { zh: 'WORLD FOOTBALL 2026', en: 'WORLD FOOTBALL 2026' },
    title: { zh: '世界因足球而沸腾', en: 'Football Unites The World' },
    subtitle: {
      zh: '热爱不分国界，荣耀即将开战。诸神黄昏的最后一舞，也是一代新王的起点。',
      en: 'Passion has no borders. Glory is about to begin: one last dance for legends, one first step for the next era.'
    },
    center: { zh: '诸神黄昏', en: 'THE LAST DANCE' },
    note: { zh: '四年等待，一战封神', en: 'Four years waiting, one night for glory' },
    dataNote: { zh: '赛程 / SP / 晋级路径同步跟踪', en: 'Fixtures / SP / route projections tracked live' }
  };

  return (
    <section className="legend-ragnarok" aria-label={copy.title[language]}>
      <div className="legend-ragnarok-sky" aria-hidden="true" />
      <div className="legend-ragnarok-head">
        <span>{copy.eyebrow[language]}</span>
        <h2>{copy.title[language]}</h2>
        <p>{copy.subtitle[language]}</p>
      </div>

      <div className="legend-ragnarok-stage">
        <div className="legend-ragnarok-title">
          <span>2026</span>
          <strong>{copy.center[language]}</strong>
          <small>{copy.note[language]}</small>
        </div>
        <div className="legend-safe-panel" aria-label={language === 'zh' ? '世界杯抽象海报位' : 'World Cup abstract poster stage'}>
          <span className="legend-safe-light" aria-hidden="true" />
          <div className="legend-safe-core">
            <span>FIFA WORLD CUP 2026</span>
            <strong>{language === 'zh' ? '赛事数据看板' : 'Tournament Desk'}</strong>
            <small>{copy.dataNote[language]}</small>
          </div>
          <div className="legend-safe-grid">
            {posterTiles.map((tile) => (
              <span className="legend-safe-tile" key={tile.value}>
                <b>{tile.value}</b>
                <small>{tile.label[language]}</small>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="legend-ragnarok-foot">
        <span>{copy.dataNote[language]}</span>
        <b>PASSION</b>
        <b>UNITY</b>
        <b>GLORY</b>
      </div>
    </section>
  );
}

import { useState, type CSSProperties } from 'react';
import type { Team } from '../services/mockData';
import { resolveTeamVisual } from '../services/teamVisuals';

interface TeamBadgeProps {
  team?: Team;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function TeamBadge({ team, size = 'md', className = '' }: TeamBadgeProps) {
  const safeTeam = team ?? {
    id: 'unknown',
    name: { zh: '未知球队', en: 'Unknown Team' },
    shortName: { zh: '未知', en: 'Unknown' },
    logo: '?',
    value: '-',
    color: '#64748b'
  };
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const [loadedLogo, setLoadedLogo] = useState<string | null>(null);
  const visual = resolveTeamVisual(safeTeam);
  const style = { '--team-color': safeTeam.color } as CSSProperties;
  const shouldRenderImage = visual.isImage && failedLogo !== visual.logo;
  const imageLoaded = loadedLogo === visual.logo;

  return (
    <span
      className={`team-badge team-badge-${size} team-badge-${visual.logoType} ${className}`.trim()}
      data-logo-kind={visual.logoType}
      style={style}
      title={visual.label}
    >
      {shouldRenderImage ? (
        <>
          <span className="team-badge-fallback">{visual.fallbackText}</span>
          <img
            className={`team-badge-img ${imageLoaded ? 'is-loaded' : ''}`.trim()}
            src={visual.logo}
            alt={visual.label}
            loading="lazy"
            referrerPolicy="no-referrer"
            onLoad={() => setLoadedLogo(visual.logo)}
            onError={() => setFailedLogo(visual.logo)}
          />
        </>
      ) : (
        <span className={visual.isImage ? 'team-badge-fallback' : undefined}>
          {visual.isImage ? visual.fallbackText : visual.logo}
        </span>
      )}
    </span>
  );
}

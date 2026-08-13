import { useState, type CSSProperties } from 'react';
import { Shield } from 'lucide-react';
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
  const isNativeFlag = visual.logoType === 'flag' && !visual.isImage && Boolean(visual.logo);
  const fallbackLabel = `${visual.label} 队徽暂缺`;

  return (
    <span
      className={`team-badge team-badge-${size} team-badge-${visual.logoType} ${className}`.trim()}
      data-logo-kind={visual.logoType}
      style={style}
      title={visual.label}
      role="img"
      aria-label={shouldRenderImage || isNativeFlag ? `${visual.label} 队徽` : fallbackLabel}
    >
      {shouldRenderImage ? (
        <>
          <span className="team-badge-fallback" aria-hidden="true">
            <Shield className="team-badge-fallback-icon" aria-hidden="true" />
          </span>
          <img
            className={`team-badge-img ${imageLoaded ? 'is-loaded' : ''}`.trim()}
            src={visual.logo}
            alt=""
            aria-hidden="true"
            loading="lazy"
            referrerPolicy="no-referrer"
            onLoad={() => setLoadedLogo(visual.logo)}
            onError={() => setFailedLogo(visual.logo)}
          />
        </>
      ) : isNativeFlag ? (
        <span className="team-badge-native-flag" aria-hidden="true">
          {visual.logo}
        </span>
      ) : (
        <span className="team-badge-fallback" aria-hidden="true">
          <Shield className="team-badge-fallback-icon" aria-hidden="true" />
        </span>
      )}
    </span>
  );
}

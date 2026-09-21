import { useState, type CSSProperties } from 'react';
import { Shield } from 'lucide-react';
import type { Team } from '../services/mockData';
import { resolveTeamVisual, type TeamVisual } from '../services/teamVisuals';

interface TeamBadgeProps {
  team?: Team;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function TeamBadge({ team, size = 'md', className = '' }: TeamBadgeProps) {
  const visual = resolveTeamVisual(team);
  // A new identity starts a fresh image attempt; previous onError state cannot
  // hide the next team's badge when a list row is reused.
  const identity = JSON.stringify([team?.id, visual.logoType, visual.candidates, visual.nativeFlag]);
  return <BadgeImage key={identity} visual={visual} size={size} className={className} color={team?.color || '#64748b'} />;
}

function BadgeImage({ visual, size, className, color }: {
  visual: TeamVisual; size: 'sm' | 'md' | 'lg'; className: string; color: string;
}) {
  const [index, setIndex] = useState(0);
  const [loadedLogo, setLoadedLogo] = useState('');
  const src = visual.candidates[index];
  const imageLoaded = Boolean(src && loadedLogo === src);
  const nativeFlag = !src && visual.logoType === 'flag' ? visual.nativeFlag : '';
  const hasVisual = Boolean(src || nativeFlag);
  const label = `${visual.label} ${hasVisual ? visual.logoType === 'flag' ? '国旗' : '队徽' : '队徽暂缺'}`;
  return (
    <span
      className={`team-badge team-badge-${size} team-badge-${visual.logoType} ${className}`.trim()}
      data-logo-kind={visual.logoType}
      data-logo-source={visual.source}
      data-logo-state={src ? imageLoaded ? 'loaded' : 'loading' : nativeFlag ? 'native-flag' : 'unavailable'}
      style={{ '--team-color': color } as CSSProperties}
      title={label}
      role="img"
      aria-label={label}
    >
      {src ? (
        <>
          <span className="team-badge-fallback" aria-hidden="true"><Shield className="team-badge-fallback-icon" aria-hidden="true" /></span>
          <img
            key={src}
            className={`team-badge-img ${imageLoaded ? 'is-loaded' : ''}`.trim()}
            src={src}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => setLoadedLogo(src)}
            onError={() => setIndex(current => current === index ? current + 1 : current)}
          />
        </>
      ) : nativeFlag ? (
        <span className="team-badge-native-flag" aria-hidden="true">{nativeFlag}</span>
      ) : (
        <span className="team-badge-fallback" aria-hidden="true"><Shield className="team-badge-fallback-icon" aria-hidden="true" /></span>
      )}
    </span>
  );
}

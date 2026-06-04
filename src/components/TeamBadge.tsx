import type { CSSProperties } from 'react';
import type { Team } from '../services/mockData';

interface TeamBadgeProps {
  team: Team;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const isImageLogo = (logo: string) => /^(https?:\/\/|\/|\.\/)/.test(logo);

export function TeamBadge({ team, size = 'md', className = '' }: TeamBadgeProps) {
  const logo = team.logo || team.shortName.en || team.name.en || '?';
  const label = team.shortName.zh || team.shortName.en || team.name.zh || team.name.en;
  const style = { '--team-color': team.color } as CSSProperties;

  return (
    <span className={`team-badge team-badge-${size} ${className}`.trim()} style={style} title={label}>
      {isImageLogo(logo) ? (
        <img src={logo} alt={label} loading="lazy" />
      ) : (
        <span>{logo}</span>
      )}
    </span>
  );
}

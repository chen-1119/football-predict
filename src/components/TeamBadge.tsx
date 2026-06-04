import type { CSSProperties } from 'react';
import type { Team } from '../services/mockData';

interface TeamBadgeProps {
  team?: Team;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const isImageLogo = (logo: string) => /^(https?:\/\/|\/|\.\/)/.test(logo);
const isFlagEmoji = (logo: string) => /\p{Regional_Indicator}/u.test(logo);

export function TeamBadge({ team, size = 'md', className = '' }: TeamBadgeProps) {
  const safeTeam = team ?? {
    id: 'unknown',
    name: { zh: '未知球队', en: 'Unknown Team' },
    shortName: { zh: '未知', en: 'Unknown' },
    logo: '?',
    value: '-',
    color: '#64748b'
  };
  const logo = safeTeam.logo || safeTeam.shortName.en || safeTeam.name.en || '?';
  const label = safeTeam.shortName.zh || safeTeam.shortName.en || safeTeam.name.zh || safeTeam.name.en;
  const style = { '--team-color': safeTeam.color } as CSSProperties;
  const logoType = safeTeam.logoType || (isFlagEmoji(logo) ? 'flag' : isImageLogo(logo) ? 'crest' : 'crest-placeholder');

  return (
    <span className={`team-badge team-badge-${size} team-badge-${logoType} ${className}`.trim()} style={style} title={label}>
      {isImageLogo(logo) ? (
        <img src={logo} alt={label} loading="lazy" />
      ) : (
        <span>{logo}</span>
      )}
    </span>
  );
}

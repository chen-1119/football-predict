import { countries, leagues, teams } from './mockData';
import type { Country, League, Team } from './mockData';

const fallbackColor = '#64748b';

export function getTeamById(teamId: string): Team {
  return teams.find((team) => team.id === teamId) ?? {
    id: teamId,
    name: { zh: '未知球队', en: 'Unknown Team' },
    shortName: { zh: '未知', en: 'Unknown' },
    logo: '?',
    value: '-',
    color: fallbackColor
  };
}

export function getLeagueById(leagueId: string): League {
  return leagues.find((league) => league.id === leagueId) ?? {
    id: leagueId,
    name: { zh: '未知赛事', en: 'Unknown League' },
    shortName: { zh: '赛事', en: 'League' },
    countryId: 'oth',
    isImportant: false
  };
}

export function getCountryById(countryId: string): Country {
  return countries.find((country) => country.id === countryId) ?? {
    id: countryId,
    name: { zh: '其他', en: 'Other' },
    flag: '🏳️'
  };
}

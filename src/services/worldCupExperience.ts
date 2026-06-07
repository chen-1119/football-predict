export type Tone = 'blue' | 'lime' | 'magenta' | 'orange' | 'purple';

export interface EventTeam {
  name: string;
  code: string;
  seed: number;
  color: string;
}

export interface FeaturedMatchData {
  stage: string;
  venue: string;
  kickoff: string;
  home: EventTeam;
  away: EventTeam;
  countdown: Array<{ label: string; value: string }>;
  odds: Array<{ label: string; value: string }>;
}

export interface LiveEvent {
  minute: string;
  title: string;
  detail: string;
  tone: Tone;
}

export interface LiveMetric {
  label: string;
  home: number;
  away: number;
  suffix?: string;
}

export interface StandingRow {
  group: string;
  team: EventTeam;
  played: number;
  points: number;
  goalDiff: string;
  status: 'Qualified zone' | 'Watch zone' | 'Pressure zone';
}

export interface RoadNode {
  round: string;
  date: string;
  teams: string;
  highlight: string;
}

export interface PlayerLeader {
  name: string;
  team: string;
  stat: string;
  value: number;
  tone: Tone;
}

export interface FanTask {
  title: string;
  reward: string;
  progress: number;
  tone: Tone;
}

export interface FanRank {
  name: string;
  points: number;
  streak: string;
}

export interface FanPollOption {
  label: string;
  value: number;
  tone: Tone;
}

export interface ScheduleMatch {
  id: string;
  status: 'Live' | 'Upcoming' | 'Finished' | 'Featured';
  time: string;
  stage: string;
  home: EventTeam;
  away: EventTeam;
  score?: string;
  tags: string[];
  tone: Tone;
}

export interface HighlightCard {
  type: 'Video' | 'News' | 'Tactical';
  title: string;
  detail: string;
  meta: string;
  tone: Tone;
}

export const eventTeams = {
  brazil: { name: 'Brazil', code: 'BR', seed: 2, color: '#f7df32' },
  france: { name: 'France', code: 'FR', seed: 3, color: '#3d7cff' },
  england: { name: 'England', code: 'ENG', seed: 4, color: '#e8eef9' },
  argentina: { name: 'Argentina', code: 'ARG', seed: 1, color: '#6ecbff' },
  spain: { name: 'Spain', code: 'ES', seed: 5, color: '#ff4f58' },
  portugal: { name: 'Portugal', code: 'POR', seed: 7, color: '#21d17d' },
  usa: { name: 'USA', code: 'USA', seed: 13, color: '#69a7ff' },
  mexico: { name: 'Mexico', code: 'MX', seed: 11, color: '#27f090' }
} satisfies Record<string, EventTeam>;

export const featuredMatch: FeaturedMatchData = {
  stage: 'Group Stage | Prime Time',
  venue: 'Miami Stadium | 72,000 fans',
  kickoff: '2026-06-18 09:00 CST',
  home: eventTeams.brazil,
  away: eventTeams.france,
  countdown: [
    { label: 'Days', value: '10' },
    { label: 'Hours', value: '08' },
    { label: 'Minutes', value: '42' },
    { label: 'Seconds', value: '06' }
  ],
  odds: [
    { label: 'Brazil Win', value: '39%' },
    { label: 'Draw', value: '28%' },
    { label: 'France Win', value: '33%' }
  ]
};

export const liveMetrics: LiveMetric[] = [
  { label: 'Possession', home: 58, away: 42, suffix: '%' },
  { label: 'Shots', home: 11, away: 8 },
  { label: 'xG Flow', home: 1.46, away: 0.92 },
  { label: 'Pressing', home: 72, away: 66, suffix: '%' }
];

export const liveTimeline: LiveEvent[] = [
  { minute: "12'", title: 'High press trap', detail: 'Brazil force a turnover near the right channel.', tone: 'lime' },
  { minute: "24'", title: 'Goal line scramble', detail: 'France survive a double chance after a corner.', tone: 'orange' },
  { minute: "39'", title: 'Momentum swing', detail: 'France shift into a 3-2 build-up and calm the game.', tone: 'blue' },
  { minute: "54'", title: 'Sub window', detail: 'Both benches prepare pace options for the final third.', tone: 'magenta' }
];

export const momentumPoints = [36, 45, 61, 72, 64, 58, 66, 78, 69, 74, 62, 57];

export const standings: StandingRow[] = [
  { group: 'A', team: eventTeams.mexico, played: 2, points: 4, goalDiff: '+2', status: 'Qualified zone' },
  { group: 'A', team: eventTeams.usa, played: 2, points: 4, goalDiff: '+1', status: 'Qualified zone' },
  { group: 'B', team: eventTeams.france, played: 2, points: 6, goalDiff: '+4', status: 'Qualified zone' },
  { group: 'B', team: eventTeams.portugal, played: 2, points: 3, goalDiff: '0', status: 'Watch zone' },
  { group: 'C', team: eventTeams.brazil, played: 2, points: 6, goalDiff: '+5', status: 'Qualified zone' },
  { group: 'C', team: eventTeams.spain, played: 2, points: 3, goalDiff: '+1', status: 'Watch zone' }
];

export const roadToFinal: RoadNode[] = [
  { round: 'R32', date: 'Jun 28', teams: 'Top 24 + best third', highlight: 'First upset window' },
  { round: 'R16', date: 'Jul 04', teams: '16 left', highlight: 'Elite routes collide' },
  { round: 'QF', date: 'Jul 09', teams: '8 left', highlight: 'Depth and fatigue' },
  { round: 'SF', date: 'Jul 14', teams: '4 left', highlight: 'Small margins only' },
  { round: 'Final', date: 'Jul 19', teams: '2 left', highlight: 'Own the world' }
];

export const playerLeaders: PlayerLeader[] = [
  { name: 'No. 7', team: 'Brazil', stat: 'Threat index', value: 94, tone: 'lime' },
  { name: 'No. 10', team: 'France', stat: 'Sprint impact', value: 91, tone: 'blue' },
  { name: 'No. 8', team: 'England', stat: 'Box arrivals', value: 88, tone: 'purple' },
  { name: 'No. 6', team: 'Spain', stat: 'Control score', value: 86, tone: 'orange' }
];

export const fanTasks: FanTask[] = [
  { title: 'Predict 3 group winners', reward: '+300 XP', progress: 64, tone: 'lime' },
  { title: 'Vote match MVP', reward: 'Badge drop', progress: 38, tone: 'magenta' },
  { title: 'Build your bracket', reward: 'Final ticket draw', progress: 82, tone: 'blue' }
];

export const fanRanks: FanRank[] = [
  { name: 'North Stand 09', points: 1280, streak: '7 hits' },
  { name: 'Neon Ultra', points: 1168, streak: '5 hits' },
  { name: 'Golden Boot AI', points: 1094, streak: '4 hits' }
];

export const fanPoll: FanPollOption[] = [
  { label: 'Brazil control the ball', value: 42, tone: 'lime' },
  { label: 'France counter wins it', value: 34, tone: 'blue' },
  { label: 'Extra-time chaos', value: 24, tone: 'magenta' }
];

export const scheduleMatches: ScheduleMatch[] = [
  { id: 'wc-br-fra', status: 'Featured', time: 'Jun 18 | 09:00', stage: 'Group C', home: eventTeams.brazil, away: eventTeams.france, tags: ['Prime', 'Attack'], tone: 'lime' },
  { id: 'wc-eng-arg', status: 'Upcoming', time: 'Jun 19 | 03:00', stage: 'Group E', home: eventTeams.england, away: eventTeams.argentina, tags: ['Rivalry', 'High press'], tone: 'purple' },
  { id: 'wc-spa-por', status: 'Live', time: "68'", stage: 'Group H', home: eventTeams.spain, away: eventTeams.portugal, score: '1 - 1', tags: ['Live', 'Momentum'], tone: 'magenta' },
  { id: 'wc-usa-mex', status: 'Finished', time: 'FT', stage: 'Group A', home: eventTeams.usa, away: eventTeams.mexico, score: '2 - 2', tags: ['Review', 'Derby'], tone: 'orange' }
];

export const highlights: HighlightCard[] = [
  { type: 'Video', title: 'The fastest counter of Matchday 1', detail: 'A 9-second transition from recovery to shot, mapped with speed lines.', meta: '02:14', tone: 'lime' },
  { type: 'Tactical', title: 'Why Brazil overload the left half-space', detail: 'Three rotations that open the penalty spot against a compact block.', meta: 'Tactical Lab', tone: 'blue' },
  { type: 'News', title: 'Host cities prepare fan plazas', detail: 'Night sessions, LED stages and live watch parties are opening across the route.', meta: 'Fan Zone', tone: 'magenta' }
];

export const scheduleFilters = ['All', 'Live', 'Featured', 'Upcoming', 'Finished'] as const;

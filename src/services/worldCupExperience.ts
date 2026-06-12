export type Tone = 'blue' | 'lime' | 'magenta' | 'orange' | 'purple';

export type EventText = {
  zh: string;
  en: string;
};

export interface EventTeam {
  name: EventText;
  code: string;
  seed: number;
  color: string;
  flag?: string;
}

export interface FeaturedMatchData {
  stage: EventText;
  venue: EventText;
  kickoff: EventText;
  home: EventTeam;
  away: EventTeam;
  countdown: Array<{ label: EventText; value: string }>;
  odds: Array<{ label: EventText; value: string }>;
}

export interface LiveEvent {
  minute: string;
  title: EventText;
  detail: EventText;
  tone: Tone;
}

export interface LiveMetric {
  label: EventText;
  home: number;
  away: number;
  suffix?: string;
}

export type StandingStatus = 'qualified' | 'watch' | 'pressure';

export interface StandingRow {
  group: string;
  team: EventTeam;
  played: number;
  points: number;
  goalDiff: string;
  status: StandingStatus;
}

export interface RoadNode {
  round: EventText;
  date: EventText;
  teams: EventText;
  highlight: EventText;
}

export interface PlayerLeader {
  name: EventText;
  team: EventText;
  stat: EventText;
  value: number;
  tone: Tone;
}

export interface FanTask {
  title: EventText;
  reward: EventText;
  progress: number;
  tone: Tone;
}

export interface FanRank {
  name: EventText;
  points: number;
  streak: EventText;
}

export interface FanPollOption {
  label: EventText;
  value: number;
  tone: Tone;
}

export type ScheduleStatus = 'all' | 'live' | 'featured' | 'upcoming' | 'finished';

export interface ScheduleMatch {
  id: string;
  status: Exclude<ScheduleStatus, 'all'>;
  time: EventText;
  stage: EventText;
  home: EventTeam;
  away: EventTeam;
  score?: string;
  tags: EventText[];
  tone: Tone;
}

export interface HighlightCard {
  type: 'video' | 'news' | 'tactical';
  title: EventText;
  detail: EventText;
  meta: EventText;
  tone: Tone;
}

const zhEn = (zh: string, en: string): EventText => ({ zh, en });

export const eventTeams = {
  mexico: { name: zhEn('墨西哥', 'Mexico'), code: 'MEX', seed: 14, color: '#12d487', flag: '🇲🇽' },
  southAfrica: { name: zhEn('南非', 'South Africa'), code: 'RSA', seed: 56, color: '#ffdd35', flag: '🇿🇦' },
  korea: { name: zhEn('韩国', 'Korea Republic'), code: 'KOR', seed: 22, color: '#ff4f58', flag: '🇰🇷' },
  czechia: { name: zhEn('捷克', 'Czechia'), code: 'CZE', seed: 39, color: '#49a6ff', flag: '🇨🇿' },
  canada: { name: zhEn('加拿大', 'Canada'), code: 'CAN', seed: 33, color: '#ff375f', flag: '🇨🇦' },
  bosnia: { name: zhEn('波黑', 'Bosnia and Herzegovina'), code: 'BIH', seed: 54, color: '#32a7ff', flag: '🇧🇦' },
  qatar: { name: zhEn('卡塔尔', 'Qatar'), code: 'QAT', seed: 53, color: '#a71930', flag: '🇶🇦' },
  switzerland: { name: zhEn('瑞士', 'Switzerland'), code: 'SUI', seed: 18, color: '#ff2f42', flag: '🇨🇭' },
  brazil: { name: zhEn('巴西', 'Brazil'), code: 'BRA', seed: 1, color: '#f7df32', flag: '🇧🇷' },
  morocco: { name: zhEn('摩洛哥', 'Morocco'), code: 'MAR', seed: 12, color: '#d72536', flag: '🇲🇦' },
  haiti: { name: zhEn('海地', 'Haiti'), code: 'HAI', seed: 83, color: '#3157ff', flag: '🇭🇹' },
  scotland: { name: zhEn('苏格兰', 'Scotland'), code: 'SCO', seed: 32, color: '#3c8cff', flag: '🏴' },
  germany: { name: zhEn('德国', 'Germany'), code: 'GER', seed: 9, color: '#f6f2e8', flag: '🇩🇪' },
  curacao: { name: zhEn('库拉索', 'Curacao'), code: 'CUW', seed: 80, color: '#18a7ff', flag: '🇨🇼' },
  france: { name: zhEn('法国', 'France'), code: 'FRA', seed: 3, color: '#3d7cff', flag: '🇫🇷' },
  senegal: { name: zhEn('塞内加尔', 'Senegal'), code: 'SEN', seed: 19, color: '#29d27f', flag: '🇸🇳' },
  england: { name: zhEn('英格兰', 'England'), code: 'ENG', seed: 4, color: '#e8eef9', flag: '🏴' },
  croatia: { name: zhEn('克罗地亚', 'Croatia'), code: 'CRO', seed: 10, color: '#ff4f58', flag: '🇭🇷' }
} satisfies Record<string, EventTeam>;

export const featuredMatch: FeaturedMatchData = {
  stage: zhEn('A组揭幕战', 'Group A opener'),
  venue: zhEn('墨西哥城体育场', 'Mexico City Stadium'),
  kickoff: zhEn('2026-06-12 03:00 北京时间', '2026-06-11 13:00 local'),
  home: eventTeams.mexico,
  away: eventTeams.southAfrica,
  countdown: [
    { label: zhEn('正赛', 'Tournament'), value: '104' },
    { label: zhEn('参赛队', 'Teams'), value: '48' },
    { label: zhEn('小组', 'Groups'), value: '12' },
    { label: zhEn('晋级', 'Advance'), value: '32' }
  ],
  odds: [
    { label: zhEn('官方 SP', 'Official SP'), value: '开售后更新' },
    { label: zhEn('模型概率', 'Model probability'), value: '赛前锁定' },
    { label: zhEn('临场复核', 'Late check'), value: '开赛前' }
  ]
};

export const liveMetrics: LiveMetric[] = [
  { label: zhEn('正赛场次', 'Official matches'), home: 104, away: 104 },
  { label: zhEn('参赛球队', 'Teams'), home: 48, away: 48 },
  { label: zhEn('小组数量', 'Groups'), home: 12, away: 12 },
  { label: zhEn('晋级名额', 'Knockout spots'), home: 32, away: 48 }
];

export const liveTimeline: LiveEvent[] = [
  {
    minute: '6/11',
    title: zhEn('揭幕战', 'Opening match'),
    detail: zhEn('墨西哥对南非，世界杯正赛从墨西哥城开始。', 'Mexico v South Africa starts the tournament in Mexico City.'),
    tone: 'lime'
  },
  {
    minute: '6/11-6/27',
    title: zhEn('小组赛', 'Group stage'),
    detail: zhEn('12 个小组，每队三场；小组前二和 8 个最好第三进入 32 强。', 'Twelve groups; top two plus eight best third-placed teams advance.'),
    tone: 'blue'
  },
  {
    minute: '6/28',
    title: zhEn('32 强淘汰赛', 'Round of 32'),
    detail: zhEn('单场淘汰开始，盘口和临场阵容权重会提高。', 'Knockout football begins; late market and lineup weight rises.'),
    tone: 'orange'
  },
  {
    minute: '7/19',
    title: zhEn('决赛', 'Final'),
    detail: zhEn('纽约新泽西决出冠军。', 'The champion is decided in New York New Jersey.'),
    tone: 'magenta'
  }
];

export const momentumPoints = [28, 36, 44, 52, 61, 69, 76, 83, 78, 72, 66, 59];

export const standingStatusLabels: Record<StandingStatus, EventText> = {
  qualified: zhEn('晋级观察', 'Advance watch'),
  watch: zhEn('参考', 'Reference'),
  pressure: zhEn('压力观察', 'Pressure watch')
};

export const standings: StandingRow[] = [
  { group: 'A', team: eventTeams.mexico, played: 0, points: 0, goalDiff: '0', status: 'watch' },
  { group: 'A', team: eventTeams.southAfrica, played: 0, points: 0, goalDiff: '0', status: 'watch' },
  { group: 'A', team: eventTeams.korea, played: 0, points: 0, goalDiff: '0', status: 'watch' },
  { group: 'A', team: eventTeams.czechia, played: 0, points: 0, goalDiff: '0', status: 'watch' },
  { group: 'B', team: eventTeams.canada, played: 0, points: 0, goalDiff: '0', status: 'watch' },
  { group: 'B', team: eventTeams.switzerland, played: 0, points: 0, goalDiff: '0', status: 'watch' }
];

export const roadToFinal: RoadNode[] = [
  { round: zhEn('32 强', 'R32'), date: zhEn('6月28日', 'Jun 28'), teams: zhEn('24 个小组前二 + 8 个最好第三', 'Top 24 + best thirds'), highlight: zhEn('淘汰赛首轮', 'First knockout window') },
  { round: zhEn('16 强', 'R16'), date: zhEn('7月4日', 'Jul 04'), teams: zhEn('剩余 16 队', '16 left'), highlight: zhEn('强队路线开始碰撞', 'Elite routes collide') },
  { round: zhEn('8 强', 'QF'), date: zhEn('7月9日', 'Jul 09'), teams: zhEn('剩余 8 队', '8 left'), highlight: zhEn('阵容深度与体能考验', 'Depth and fatigue') },
  { round: zhEn('半决赛', 'SF'), date: zhEn('7月14日', 'Jul 14'), teams: zhEn('剩余 4 队', '4 left'), highlight: zhEn('细节决定上限', 'Small margins only') },
  { round: zhEn('决赛', 'Final'), date: zhEn('7月19日', 'Jul 19'), teams: zhEn('最后 2 队', '2 left'), highlight: zhEn('冠军之夜', 'Own the world') }
];

export const playerLeaders: PlayerLeader[] = [
  { name: zhEn('巴西', 'Brazil'), team: eventTeams.brazil.name, stat: zhEn('夺冠热度', 'Title heat'), value: 91, tone: 'lime' },
  { name: zhEn('法国', 'France'), team: eventTeams.france.name, stat: zhEn('阵容深度', 'Squad depth'), value: 89, tone: 'blue' },
  { name: zhEn('英格兰', 'England'), team: eventTeams.england.name, stat: zhEn('进攻火力', 'Attack rating'), value: 86, tone: 'purple' },
  { name: zhEn('德国', 'Germany'), team: eventTeams.germany.name, stat: zhEn('赛程关注', 'Schedule focus'), value: 82, tone: 'orange' }
];

export const fanTasks: FanTask[] = [
  { title: zhEn('提交 3 场小组赛比分', 'Predict 3 group scores'), reward: zhEn('+300 积分', '+300 XP'), progress: 64, tone: 'lime' },
  { title: zhEn('参与揭幕战投票', 'Vote on the opener'), reward: zhEn('点亮徽章', 'Badge drop'), progress: 38, tone: 'magenta' },
  { title: zhEn('生成你的晋级路线', 'Build your bracket'), reward: zhEn('排行榜入场', 'Leaderboard entry'), progress: 82, tone: 'blue' }
];

export const fanRanks: FanRank[] = [
  { name: zhEn('北看台 09', 'North Stand 09'), points: 1280, streak: zhEn('命中 7 场', '7 hits') },
  { name: zhEn('霓虹看球团', 'Neon Ultra'), points: 1168, streak: zhEn('命中 5 场', '5 hits') },
  { name: zhEn('金靴观察员', 'Golden Boot AI'), points: 1094, streak: zhEn('命中 4 场', '4 hits') }
];

export const fanPoll: FanPollOption[] = [
  { label: zhEn('墨西哥主场开门红', 'Mexico home opener'), value: 42, tone: 'lime' },
  { label: zhEn('南非防反抢分', 'South Africa counter punch'), value: 34, tone: 'blue' },
  { label: zhEn('揭幕战握手言和', 'Opening draw'), value: 24, tone: 'magenta' }
];

export const scheduleStatusLabels: Record<Exclude<ScheduleStatus, 'all'>, EventText> = {
  live: zhEn('进行中', 'Live'),
  upcoming: zhEn('未开赛', 'Upcoming'),
  finished: zhEn('已完场', 'Finished'),
  featured: zhEn('焦点赛', 'Featured')
};

export const scheduleMatches: ScheduleMatch[] = [
  {
    id: 'wc-mex-rsa',
    status: 'featured',
    time: zhEn('6月12日 03:00', 'Jun 11 | 13:00 local'),
    stage: zhEn('A组', 'Group A'),
    home: eventTeams.mexico,
    away: eventTeams.southAfrica,
    tags: [zhEn('揭幕战', 'Opener'), zhEn('东道主', 'Host')],
    tone: 'lime'
  },
  {
    id: 'wc-can-bih',
    status: 'upcoming',
    time: zhEn('6月13日 03:00', 'Jun 12 | Toronto'),
    stage: zhEn('B组', 'Group B'),
    home: eventTeams.canada,
    away: eventTeams.bosnia,
    tags: [zhEn('东道主', 'Host'), zhEn('小组首轮', 'MD1')],
    tone: 'blue'
  },
  {
    id: 'wc-kor-cze',
    status: 'upcoming',
    time: zhEn('6月13日 10:00', 'Jun 12 | Guadalajara'),
    stage: zhEn('A组', 'Group A'),
    home: eventTeams.korea,
    away: eventTeams.czechia,
    tags: [zhEn('小组首轮', 'MD1'), zhEn('节奏对抗', 'Tempo')],
    tone: 'magenta'
  },
  {
    id: 'wc-bra-mar',
    status: 'upcoming',
    time: zhEn('6月15日 06:00', 'Jun 14 | New York New Jersey'),
    stage: zhEn('C组', 'Group C'),
    home: eventTeams.brazil,
    away: eventTeams.morocco,
    tags: [zhEn('强强关注', 'Prime'), zhEn('进攻对抗', 'Attack')],
    tone: 'orange'
  }
];

export const highlightTypeLabels: Record<HighlightCard['type'], EventText> = {
  video: zhEn('视频', 'Video'),
  news: zhEn('资讯', 'News'),
  tactical: zhEn('战术', 'Tactical')
};

export const highlights: HighlightCard[] = [
  {
    type: 'news',
    title: zhEn('揭幕战时间确认', 'Opening match confirmed'),
    detail: zhEn('墨西哥与南非将在墨西哥城打响 2026 世界杯第一场正赛。', 'Mexico and South Africa open the 2026 tournament in Mexico City.'),
    meta: zhEn('赛程', 'Schedule'),
    tone: 'lime'
  },
  {
    type: 'tactical',
    title: zhEn('12 组出线规则', 'How teams advance'),
    detail: zhEn('每组前二直接晋级，另外 8 个成绩最好的小组第三进入 32 强。', 'Top two in each group plus eight best third-placed teams reach the Round of 32.'),
    meta: zhEn('规则', 'Rules'),
    tone: 'blue'
  },
  {
    type: 'video',
    title: zhEn('球迷任务与命中挑战', 'Fan picks and hit challenge'),
    detail: zhEn('用户可提交比分观点，赛后自动统计命中内容和排行榜。', 'Fans can submit score picks and see post-match hit stats.'),
    meta: zhEn('互动', 'Fan Zone'),
    tone: 'magenta'
  }
];

export const scheduleFilters = ['all', 'featured', 'upcoming', 'live', 'finished'] as const;

export const scheduleFilterLabels: Record<ScheduleStatus, EventText> = {
  all: zhEn('全部', 'All'),
  live: zhEn('进行中', 'Live'),
  featured: zhEn('焦点赛', 'Featured'),
  upcoming: zhEn('未开赛', 'Upcoming'),
  finished: zhEn('已完场', 'Finished')
};

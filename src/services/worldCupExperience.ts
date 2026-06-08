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
  brazil: { name: zhEn('巴西', 'Brazil'), code: 'BR', seed: 2, color: '#f7df32' },
  france: { name: zhEn('法国', 'France'), code: 'FR', seed: 3, color: '#3d7cff' },
  england: { name: zhEn('英格兰', 'England'), code: 'ENG', seed: 4, color: '#e8eef9' },
  argentina: { name: zhEn('阿根廷', 'Argentina'), code: 'ARG', seed: 1, color: '#6ecbff' },
  spain: { name: zhEn('西班牙', 'Spain'), code: 'ES', seed: 5, color: '#ff4f58' },
  portugal: { name: zhEn('葡萄牙', 'Portugal'), code: 'POR', seed: 7, color: '#21d17d' },
  usa: { name: zhEn('美国', 'USA'), code: 'USA', seed: 13, color: '#69a7ff' },
  mexico: { name: zhEn('墨西哥', 'Mexico'), code: 'MX', seed: 11, color: '#27f090' }
} satisfies Record<string, EventTeam>;

export const featuredMatch: FeaturedMatchData = {
  stage: zhEn('小组赛 | 黄金时段', 'Group Stage | Prime Time'),
  venue: zhEn('迈阿密球场 | 72,000 名球迷', 'Miami Stadium | 72,000 fans'),
  kickoff: zhEn('2026-06-18 09:00 北京时间', '2026-06-18 09:00 CST'),
  home: eventTeams.brazil,
  away: eventTeams.france,
  countdown: [
    { label: zhEn('天', 'Days'), value: '10' },
    { label: zhEn('小时', 'Hours'), value: '08' },
    { label: zhEn('分钟', 'Minutes'), value: '42' },
    { label: zhEn('秒', 'Seconds'), value: '06' }
  ],
  odds: [
    { label: zhEn('巴西胜', 'Brazil Win'), value: '39%' },
    { label: zhEn('平局', 'Draw'), value: '28%' },
    { label: zhEn('法国胜', 'France Win'), value: '33%' }
  ]
};

export const liveMetrics: LiveMetric[] = [
  { label: zhEn('控球率', 'Possession'), home: 58, away: 42, suffix: '%' },
  { label: zhEn('射门', 'Shots'), home: 11, away: 8 },
  { label: zhEn('xG走势', 'xG Flow'), home: 1.46, away: 0.92 },
  { label: zhEn('压迫强度', 'Pressing'), home: 72, away: 66, suffix: '%' }
];

export const liveTimeline: LiveEvent[] = [
  {
    minute: "12'",
    title: zhEn('高位压迫陷阱', 'High press trap'),
    detail: zhEn('巴西在右路迫使对手出球失误，形成一次快速推进。', 'Brazil force a turnover near the right channel.'),
    tone: 'lime'
  },
  {
    minute: "24'",
    title: zhEn('门前混战', 'Goal line scramble'),
    detail: zhEn('法国角球后连续化解两次射门，防线压力明显上升。', 'France survive a double chance after a corner.'),
    tone: 'orange'
  },
  {
    minute: "39'",
    title: zhEn('节奏转折', 'Momentum swing'),
    detail: zhEn('法国改成 3-2 出球站位，开始降低比赛速度。', 'France shift into a 3-2 build-up and calm the game.'),
    tone: 'blue'
  },
  {
    minute: "54'",
    title: zhEn('换人窗口', 'Sub window'),
    detail: zhEn('双方替补席都在准备提速球员，最后三十分钟会更开放。', 'Both benches prepare pace options for the final third.'),
    tone: 'magenta'
  }
];

export const momentumPoints = [36, 45, 61, 72, 64, 58, 66, 78, 69, 74, 62, 57];

export const standingStatusLabels: Record<StandingStatus, EventText> = {
  qualified: zhEn('晋级区', 'Qualified zone'),
  watch: zhEn('观察区', 'Watch zone'),
  pressure: zhEn('压力区', 'Pressure zone')
};

export const standings: StandingRow[] = [
  { group: 'A', team: eventTeams.mexico, played: 2, points: 4, goalDiff: '+2', status: 'qualified' },
  { group: 'A', team: eventTeams.usa, played: 2, points: 4, goalDiff: '+1', status: 'qualified' },
  { group: 'B', team: eventTeams.france, played: 2, points: 6, goalDiff: '+4', status: 'qualified' },
  { group: 'B', team: eventTeams.portugal, played: 2, points: 3, goalDiff: '0', status: 'watch' },
  { group: 'C', team: eventTeams.brazil, played: 2, points: 6, goalDiff: '+5', status: 'qualified' },
  { group: 'C', team: eventTeams.spain, played: 2, points: 3, goalDiff: '+1', status: 'watch' }
];

export const roadToFinal: RoadNode[] = [
  { round: zhEn('32 强', 'R32'), date: zhEn('6月28日', 'Jun 28'), teams: zhEn('前 24 名 + 最佳小组第三', 'Top 24 + best third'), highlight: zhEn('第一轮冷门窗口', 'First upset window') },
  { round: zhEn('16 强', 'R16'), date: zhEn('7月4日', 'Jul 04'), teams: zhEn('剩余 16 队', '16 left'), highlight: zhEn('强队路线开始碰撞', 'Elite routes collide') },
  { round: zhEn('8 强', 'QF'), date: zhEn('7月9日', 'Jul 09'), teams: zhEn('剩余 8 队', '8 left'), highlight: zhEn('阵容深度与体能考验', 'Depth and fatigue') },
  { round: zhEn('半决赛', 'SF'), date: zhEn('7月14日', 'Jul 14'), teams: zhEn('剩余 4 队', '4 left'), highlight: zhEn('细节决定上限', 'Small margins only') },
  { round: zhEn('决赛', 'Final'), date: zhEn('7月19日', 'Jul 19'), teams: zhEn('最后 2 队', '2 left'), highlight: zhEn('主宰世界', 'Own the world') }
];

export const playerLeaders: PlayerLeader[] = [
  { name: zhEn('7号核心', 'No. 7'), team: eventTeams.brazil.name, stat: zhEn('威胁指数', 'Threat index'), value: 94, tone: 'lime' },
  { name: zhEn('10号核心', 'No. 10'), team: eventTeams.france.name, stat: zhEn('冲刺影响', 'Sprint impact'), value: 91, tone: 'blue' },
  { name: zhEn('8号中场', 'No. 8'), team: eventTeams.england.name, stat: zhEn('禁区到位', 'Box arrivals'), value: 88, tone: 'purple' },
  { name: zhEn('6号节拍器', 'No. 6'), team: eventTeams.spain.name, stat: zhEn('控制评分', 'Control score'), value: 86, tone: 'orange' }
];

export const fanTasks: FanTask[] = [
  { title: zhEn('预测 3 个小组头名', 'Predict 3 group winners'), reward: zhEn('+300 积分', '+300 XP'), progress: 64, tone: 'lime' },
  { title: zhEn('投票本场 MVP', 'Vote match MVP'), reward: zhEn('点亮徽章', 'Badge drop'), progress: 38, tone: 'magenta' },
  { title: zhEn('生成你的晋级图', 'Build your bracket'), reward: zhEn('决赛抽签资格', 'Final ticket draw'), progress: 82, tone: 'blue' }
];

export const fanRanks: FanRank[] = [
  { name: zhEn('北看台09', 'North Stand 09'), points: 1280, streak: zhEn('连中 7 场', '7 hits') },
  { name: zhEn('霓虹看球团', 'Neon Ultra'), points: 1168, streak: zhEn('连中 5 场', '5 hits') },
  { name: zhEn('金靴AI队', 'Golden Boot AI'), points: 1094, streak: zhEn('连中 4 场', '4 hits') }
];

export const fanPoll: FanPollOption[] = [
  { label: zhEn('巴西掌控球权', 'Brazil control the ball'), value: 42, tone: 'lime' },
  { label: zhEn('法国反击制胜', 'France counter wins it'), value: 34, tone: 'blue' },
  { label: zhEn('加时混战', 'Extra-time chaos'), value: 24, tone: 'magenta' }
];

export const scheduleStatusLabels: Record<Exclude<ScheduleStatus, 'all'>, EventText> = {
  live: zhEn('进行中', 'Live'),
  upcoming: zhEn('未开赛', 'Upcoming'),
  finished: zhEn('已完场', 'Finished'),
  featured: zhEn('焦点赛', 'Featured')
};

export const scheduleMatches: ScheduleMatch[] = [
  {
    id: 'wc-br-fra',
    status: 'featured',
    time: zhEn('6月18日 09:00', 'Jun 18 | 09:00'),
    stage: zhEn('C组', 'Group C'),
    home: eventTeams.brazil,
    away: eventTeams.france,
    tags: [zhEn('焦点', 'Prime'), zhEn('进攻对话', 'Attack')],
    tone: 'lime'
  },
  {
    id: 'wc-eng-arg',
    status: 'upcoming',
    time: zhEn('6月19日 03:00', 'Jun 19 | 03:00'),
    stage: zhEn('E组', 'Group E'),
    home: eventTeams.england,
    away: eventTeams.argentina,
    tags: [zhEn('宿敌', 'Rivalry'), zhEn('高位压迫', 'High press')],
    tone: 'purple'
  },
  {
    id: 'wc-spa-por',
    status: 'live',
    time: zhEn("68'", "68'"),
    stage: zhEn('H组', 'Group H'),
    home: eventTeams.spain,
    away: eventTeams.portugal,
    score: '1 - 1',
    tags: [zhEn('实时', 'Live'), zhEn('走势拉满', 'Momentum')],
    tone: 'magenta'
  },
  {
    id: 'wc-usa-mex',
    status: 'finished',
    time: zhEn('完场', 'FT'),
    stage: zhEn('A组', 'Group A'),
    home: eventTeams.usa,
    away: eventTeams.mexico,
    score: '2 - 2',
    tags: [zhEn('复盘', 'Review'), zhEn('德比', 'Derby')],
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
    type: 'video',
    title: zhEn('小组赛首轮最快反击', 'The fastest counter of Matchday 1'),
    detail: zhEn('从抢回球权到完成射门只用 9 秒，用速度线拆解推进路径。', 'A 9-second transition from recovery to shot, mapped with speed lines.'),
    meta: zhEn('02:14', '02:14'),
    tone: 'lime'
  },
  {
    type: 'tactical',
    title: zhEn('巴西为何重压左肋部', 'Why Brazil overload the left half-space'),
    detail: zhEn('三次轮转打开点球点区域，专门针对紧凑防线。', 'Three rotations that open the penalty spot against a compact block.'),
    meta: zhEn('战术实验室', 'Tactical Lab'),
    tone: 'blue'
  },
  {
    type: 'news',
    title: zhEn('主办城市球迷广场准备中', 'Host cities prepare fan plazas'),
    detail: zhEn('夜场观赛、LED 舞台和城市大屏陆续开放。', 'Night sessions, LED stages and live watch parties are opening across the route.'),
    meta: zhEn('球迷区', 'Fan Zone'),
    tone: 'magenta'
  }
];

export const scheduleFilters = ['all', 'live', 'featured', 'upcoming', 'finished'] as const;

export const scheduleFilterLabels: Record<ScheduleStatus, EventText> = {
  all: zhEn('全部', 'All'),
  live: zhEn('进行中', 'Live'),
  featured: zhEn('焦点赛', 'Featured'),
  upcoming: zhEn('未开赛', 'Upcoming'),
  finished: zhEn('已完场', 'Finished')
};

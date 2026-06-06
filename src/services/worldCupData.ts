import type { Match, MultiLangString, PredictionDetail } from './mockData';
import { getImpliedProbabilities } from './bettingDisplay';
import { getLeagueById, getTeamById } from './entities';

export const WORLD_CUP_OFFICIAL = {
  name: {
    zh: '2026 世界杯',
    en: 'World Cup 2026'
  },
  host: {
    zh: '加拿大 / 墨西哥 / 美国',
    en: 'Canada / Mexico / USA'
  },
  startDate: '2026-06-11',
  finalDate: '2026-07-19',
  teams: 48,
  matches: 104,
  groups: 12,
  venues: 16
};

export interface WorldCupTeamSeed {
  id: string;
  name: MultiLangString;
  shortName: MultiLangString;
  flag: string;
  fifaRank: number;
  confederation: string;
  isHost?: boolean;
  isDebut?: boolean;
  note: MultiLangString;
}

export interface WorldCupGroupSeed {
  id: string;
  dates: MultiLangString;
  venueHint: MultiLangString;
  headline: MultiLangString;
  teams: WorldCupTeamSeed[];
}

export interface WorldCupTeamForecast extends WorldCupTeamSeed {
  groupId: string;
  projectedRank: number;
  projectedPoints: number;
  groupWinProbability: number;
  advanceProbability: number;
  routeLabel: MultiLangString;
  signal: MultiLangString;
  strengthScore: number;
}

export interface WorldCupGroupForecast extends Omit<WorldCupGroupSeed, 'teams'> {
  teams: WorldCupTeamForecast[];
}

export interface WorldCupKnockoutRound {
  id: 'r32' | 'r16' | 'qf' | 'sf' | 'third' | 'final';
  title: MultiLangString;
  dates: MultiLangString;
  matches: number;
  detail: MultiLangString;
}

export interface WorldCupRouteForecast {
  team: WorldCupTeamForecast;
  round32: number;
  round16: number;
  quarterFinal: number;
  semiFinal: number;
  final: number;
  champion: number;
  tier: MultiLangString;
}

const wcTeam = (
  id: string,
  zh: string,
  en: string,
  flag: string,
  fifaRank: number,
  noteZh: string,
  noteEn: string,
  options: Pick<WorldCupTeamSeed, 'isHost' | 'isDebut'> = {}
): WorldCupTeamSeed => ({
  id,
  name: { zh, en },
  shortName: { zh, en },
  flag,
  fifaRank,
  confederation: '',
  note: { zh: noteZh, en: noteEn },
  ...options
});

export const WORLD_CUP_GROUPS: WorldCupGroupSeed[] = [
  {
    id: 'A',
    dates: { zh: '6/11 - 6/24', en: 'Jun 11 - Jun 24' },
    venueHint: { zh: '墨西哥主场窗口', en: 'Mexico host lane' },
    headline: { zh: '东道主墨西哥有主场加成，韩国和捷克抢第二，南非看反击质量。', en: 'Mexico carry host edge; Korea Republic and Czechia contest second, South Africa need transition efficiency.' },
    teams: [
      wcTeam('mexico', '墨西哥', 'Mexico', '🇲🇽', 15, '东道主，开幕战热度高。', 'Host nation with opener pressure.', { isHost: true }),
      wcTeam('south-africa', '南非', 'South Africa', '🇿🇦', 60, '身体和转换有爆点，但稳定性偏弱。', 'Physical transition side with volatility.'),
      wcTeam('south-korea', '韩国', 'Korea Republic', '🇰🇷', 25, '亚洲强队，跑动和边路压迫稳定。', 'High work-rate Asian contender.'),
      wcTeam('czechia', '捷克', 'Czechia', '🇨🇿', 41, '定位球和对抗能力是抢分核心。', 'Set pieces and duels are key.')
    ]
  },
  {
    id: 'B',
    dates: { zh: '6/12 - 6/24', en: 'Jun 12 - Jun 24' },
    venueHint: { zh: '加拿大主场窗口', en: 'Canada host lane' },
    headline: { zh: '瑞士纸面最稳，加拿大有主场，波黑和卡塔尔争第三弹性。', en: 'Switzerland look the baseline pick; Canada hold host edge while Bosnia and Qatar fight for third-place value.' },
    teams: [
      wcTeam('canada', '加拿大', 'Canada', '🇨🇦', 30, '东道主，节奏和冲击力强。', 'Host nation with pace and vertical threat.', { isHost: true }),
      wcTeam('switzerland', '瑞士', 'Switzerland', '🇨🇭', 19, '大赛稳定性强，防守下限高。', 'Tournament stability and defensive floor.'),
      wcTeam('qatar', '卡塔尔', 'Qatar', '🇶🇦', 55, '杯赛经验足，但对抗强度是疑问。', 'Cup experience, but physical ceiling is a question.'),
      wcTeam('bosnia', '波黑', 'Bosnia and Herzegovina', '🇧🇦', 65, '锋线对抗不错，需要控制失误。', 'Has forward presence, must reduce errors.')
    ]
  },
  {
    id: 'C',
    dates: { zh: '6/13 - 6/24', en: 'Jun 13 - Jun 24' },
    venueHint: { zh: '美东强队组', en: 'East Coast heavyweights' },
    headline: { zh: '巴西和摩洛哥强度领先，苏格兰具备抢第三甚至第二的硬度。', en: 'Brazil and Morocco lead the strength tier; Scotland can push the top two with structure.' },
    teams: [
      wcTeam('brazil', '巴西', 'Brazil', '🇧🇷', 6, '天赋上限高，淘汰赛深度候选。', 'Elite ceiling and knockout depth.'),
      wcTeam('morocco', '摩洛哥', 'Morocco', '🇲🇦', 8, '防守组织强，近年大赛证明过抗压。', 'Strong defensive structure and tournament proof.'),
      wcTeam('haiti', '海地', 'Haiti', '🇭🇹', 83, '低排名球队，重点看定位球和反击效率。', 'Long shot reliant on set pieces and counters.'),
      wcTeam('scotland', '苏格兰', 'Scotland', '🏴', 43, '身体对抗和二点球强，能制造硬仗。', 'Physical midfield and second-ball pressure.')
    ]
  },
  {
    id: 'D',
    dates: { zh: '6/12 - 6/25', en: 'Jun 12 - Jun 25' },
    venueHint: { zh: '美国西海岸路径', en: 'US West Coast path' },
    headline: { zh: '美国有主场与速度优势，土耳其天赋高，澳大利亚和巴拉圭都很难缠。', en: 'USA have host and pace advantages; Turkey bring ceiling, Australia and Paraguay raise the floor of the group.' },
    teams: [
      wcTeam('usa', '美国', 'United States', '🇺🇸', 16, '东道主，前场速度和主场氛围加分。', 'Host nation with speed and home atmosphere.', { isHost: true }),
      wcTeam('turkey', '土耳其', 'Turkey', '🇹🇷', 22, '中前场天赋好，但稳定性需要验证。', 'High attacking talent, consistency still matters.'),
      wcTeam('australia', '澳大利亚', 'Australia', '🇦🇺', 27, '纪律性强，淘汰赛经验丰富。', 'Disciplined and tournament-tested.'),
      wcTeam('paraguay', '巴拉圭', 'Paraguay', '🇵🇾', 40, '防守韧性好，适合低比分拉扯。', 'Resilient defensive side suited to tight games.')
    ]
  },
  {
    id: 'E',
    dates: { zh: '6/14 - 6/25', en: 'Jun 14 - Jun 25' },
    venueHint: { zh: '德国领跑组', en: 'Germany-led group' },
    headline: { zh: '德国强度占优，厄瓜多尔与科特迪瓦抢第二，库拉索更多看爆冷。', en: 'Germany are the benchmark; Ecuador and Ivory Coast fight second while Curaçao need an upset profile.' },
    teams: [
      wcTeam('germany', '德国', 'Germany', '🇩🇪', 10, '阵容深度强，控制力是基本盘。', 'Depth and control form the base.'),
      wcTeam('curacao', '库拉索', 'Curaçao', '🇨🇼', 82, '世界杯新军，容错率偏低。', 'Tournament debutant with little margin.', { isDebut: true }),
      wcTeam('ivory-coast', '科特迪瓦', 'Ivory Coast', '🇨🇮', 34, '身体和冲击力强，具备爆点。', 'Power and direct threat.'),
      wcTeam('ecuador', '厄瓜多尔', 'Ecuador', '🇪🇨', 23, '南美强度好，防守质量稳定。', 'Good CONMEBOL intensity and defensive base.')
    ]
  },
  {
    id: 'F',
    dates: { zh: '6/14 - 6/25', en: 'Jun 14 - Jun 25' },
    venueHint: { zh: '荷兰日本焦点组', en: 'Netherlands-Japan focus' },
    headline: { zh: '荷兰和日本是出线热门，瑞典冲击第二，突尼斯有低比分搅局能力。', en: 'Netherlands and Japan lead; Sweden can challenge second, Tunisia can drag games into low-scoring variance.' },
    teams: [
      wcTeam('netherlands', '荷兰', 'Netherlands', '🇳🇱', 7, '攻防框架成熟，强强战下限高。', 'Mature structure and strong-game floor.'),
      wcTeam('japan', '日本', 'Japan', '🇯🇵', 18, '转换和压迫成熟，冷门能力强。', 'Pressing and transitions make upset value real.'),
      wcTeam('sweden', '瑞典', 'Sweden', '🇸🇪', 38, '身体和定位球稳定，适合杯赛。', 'Physical, set-piece reliable cup side.'),
      wcTeam('tunisia', '突尼斯', 'Tunisia', '🇹🇳', 44, '防守密度好，进攻效率是关键。', 'Compact defense, attack efficiency is key.')
    ]
  },
  {
    id: 'G',
    dates: { zh: '6/15 - 6/26', en: 'Jun 15 - Jun 26' },
    venueHint: { zh: '比利时埃及伊朗混战', en: 'Belgium-Egypt-Iran race' },
    headline: { zh: '比利时纸面领先，伊朗和埃及的排名/风格差距不大，新西兰看防守抗压。', en: 'Belgium start ahead; Iran and Egypt are close by rank and style, New Zealand need defensive resistance.' },
    teams: [
      wcTeam('belgium', '比利时', 'Belgium', '🇧🇪', 9, '仍有顶级个人能力，防线更新是变量。', 'Elite individuals, defensive refresh is the variable.'),
      wcTeam('egypt', '埃及', 'Egypt', '🇪🇬', 29, '核心带动明显，反击质量高。', 'Star-led attack with good transition value.'),
      wcTeam('iran', '伊朗', 'Iran', '🇮🇷', 21, '组织纪律强，低比分稳定。', 'Organized and comfortable in low-scoring games.'),
      wcTeam('new-zealand', '新西兰', 'New Zealand', '🇳🇿', 85, '长传和对抗有特点，但整体强度吃亏。', 'Direct and physical, but weaker overall depth.')
    ]
  },
  {
    id: 'H',
    dates: { zh: '6/15 - 6/26', en: 'Jun 15 - Jun 26' },
    venueHint: { zh: '西班牙乌拉圭强强组', en: 'Spain-Uruguay power lane' },
    headline: { zh: '西班牙和乌拉圭强度突出，沙特与佛得角要争第三窗口。', en: 'Spain and Uruguay stand out; Saudi Arabia and Cape Verde target the third-place lane.' },
    teams: [
      wcTeam('spain', '西班牙', 'Spain', '🇪🇸', 2, '控球和压迫兼具，争冠第一档。', 'Control and pressing place them in the title tier.'),
      wcTeam('cape-verde', '佛得角', 'Cape Verde', '🇨🇻', 69, '世界杯新军，锋线速度有威胁。', 'Debutant with forward pace.', { isDebut: true }),
      wcTeam('saudi-arabia', '沙特阿拉伯', 'Saudi Arabia', '🇸🇦', 61, '杯赛韧性不错，但防守连续性要看。', 'Cup resilience, defensive continuity matters.'),
      wcTeam('uruguay', '乌拉圭', 'Uruguay', '🇺🇾', 17, '压迫和对抗强，淘汰赛潜力高。', 'Aggressive pressing and knockout upside.')
    ]
  },
  {
    id: 'I',
    dates: { zh: '6/16 - 6/26', en: 'Jun 16 - Jun 26' },
    venueHint: { zh: '死亡组候选', en: 'Group of death candidate' },
    headline: { zh: '法国第一档，塞内加尔和挪威争第二，伊拉克需要把比赛拖进低比分。', en: 'France lead the tier; Senegal and Norway battle for second while Iraq need low-scoring variance.' },
    teams: [
      wcTeam('france', '法国', 'France', '🇫🇷', 1, '阵容厚度和速度顶级，争冠核心。', 'Depth and pace make them a title anchor.'),
      wcTeam('senegal', '塞内加尔', 'Senegal', '🇸🇳', 14, '身体强度和大赛经验都在线。', 'Physical strength and tournament experience.'),
      wcTeam('norway', '挪威', 'Norway', '🇳🇴', 31, '锋线天赋高，防守平衡是关键。', 'Elite attacking talent, defensive balance is key.'),
      wcTeam('iraq', '伊拉克', 'Iraq', '🇮🇶', 57, '需要纪律性和定位球抢分。', 'Needs discipline and set-piece points.')
    ]
  },
  {
    id: 'J',
    dates: { zh: '6/16 - 6/26', en: 'Jun 16 - Jun 26' },
    venueHint: { zh: '阿根廷卫冕组', en: 'Argentina defense lane' },
    headline: { zh: '阿根廷目标头名，奥地利整体性强，阿尔及利亚和约旦看第三。', en: 'Argentina target first; Austria are organized, Algeria and Jordan chase third-place openings.' },
    teams: [
      wcTeam('argentina', '阿根廷', 'Argentina', '🇦🇷', 3, '卫冕冠军，经验和控场能力强。', 'Defending champions with control and experience.'),
      wcTeam('algeria', '阿尔及利亚', 'Algeria', '🇩🇿', 28, '前场个人能力好，节奏波动需控制。', 'Attacking quality, must manage tempo swings.'),
      wcTeam('austria', '奥地利', 'Austria', '🇦🇹', 24, '压迫体系成熟，能打高强度。', 'Mature pressing system and high intensity.'),
      wcTeam('jordan', '约旦', 'Jordan', '🇯🇴', 63, '世界杯新军，反击效率决定上限。', 'Debutant whose ceiling depends on counter efficiency.', { isDebut: true })
    ]
  },
  {
    id: 'K',
    dates: { zh: '6/17 - 6/27', en: 'Jun 17 - Jun 27' },
    venueHint: { zh: '葡萄牙哥伦比亚焦点', en: 'Portugal-Colombia focus' },
    headline: { zh: '葡萄牙和哥伦比亚明显领先，刚果民主共和国与乌兹别克斯坦抢第三。', en: 'Portugal and Colombia lead; DR Congo and Uzbekistan fight the third-place route.' },
    teams: [
      wcTeam('portugal', '葡萄牙', 'Portugal', '🇵🇹', 5, '阵容深度强，进攻选择丰富。', 'Deep squad with varied attacking options.'),
      wcTeam('uzbekistan', '乌兹别克斯坦', 'Uzbekistan', '🇺🇿', 50, '世界杯新军，体系纪律性不错。', 'Debutant with good structure.', { isDebut: true }),
      wcTeam('colombia', '哥伦比亚', 'Colombia', '🇨🇴', 13, '南美强队，反击与个人能力兼具。', 'CONMEBOL strength with transition and individual quality.'),
      wcTeam('dr-congo', '刚果民主共和国', 'DR Congo', '🇨🇩', 46, '身体冲击力强，杯赛变数大。', 'Physical upside and cup variance.')
    ]
  },
  {
    id: 'L',
    dates: { zh: '6/17 - 6/27', en: 'Jun 17 - Jun 27' },
    venueHint: { zh: '英格兰克罗地亚焦点', en: 'England-Croatia focus' },
    headline: { zh: '英格兰纸面强度高，克罗地亚经验足，巴拿马和加纳争第三。', en: 'England have elite squad strength, Croatia bring experience, Panama and Ghana chase third.' },
    teams: [
      wcTeam('england', '英格兰', 'England', '🏴', 4, '阵容深度顶级，争冠候选。', 'Elite squad depth and title candidate.'),
      wcTeam('croatia', '克罗地亚', 'Croatia', '🇭🇷', 11, '大赛经验强，中场控制仍是优势。', 'Tournament experience and midfield control.'),
      wcTeam('ghana', '加纳', 'Ghana', '🇬🇭', 74, '身体条件好，但防守稳定性需验证。', 'Athletic upside, defensive consistency needs proof.'),
      wcTeam('panama', '巴拿马', 'Panama', '🇵🇦', 33, '排名不低，纪律性和反击值得看。', 'Solid ranking, discipline and counters matter.')
    ]
  }
];

export const WORLD_CUP_STAGE_CARDS = [
  {
    title: { zh: '小组赛', en: 'Group Stage' },
    value: { zh: '12 组 x 4 队', en: '12 groups x 4 teams' },
    detail: {
      zh: '每组前 2 名 + 8 个成绩最好的小组第三进入 32 强。',
      en: 'Top two from each group plus eight best third-place teams reach the Round of 32.'
    }
  },
  {
    title: { zh: '淘汰赛', en: 'Knockout' },
    value: { zh: '32 强起步', en: 'Starts at R32' },
    detail: {
      zh: '32 强、16 强、8 强、半决赛、三四名、决赛全路径追踪。',
      en: 'Tracks Round of 32, Round of 16, quarters, semis, third place and final.'
    }
  },
  {
    title: { zh: '赛程窗口', en: 'Schedule Window' },
    value: { zh: '6/11 - 7/19', en: 'Jun 11 - Jul 19' },
    detail: {
      zh: '页面优先读取官方竞彩赛程；世界杯场次上线后自动纳入观察池。',
      en: 'The page prioritizes official Sporttery fixtures and folds World Cup matches into the watch pool.'
    }
  }
];

export const WORLD_CUP_KNOCKOUT_ROUNDS: WorldCupKnockoutRound[] = [
  {
    id: 'r32',
    title: { zh: '32 强', en: 'Round of 32' },
    dates: { zh: '6/28 - 7/3', en: 'Jun 28 - Jul 3' },
    matches: 16,
    detail: { zh: '12 个小组前二 + 8 个最佳第三进入单场淘汰。', en: '12 group top-two teams plus eight best third-placed teams enter single elimination.' }
  },
  {
    id: 'r16',
    title: { zh: '16 强', en: 'Round of 16' },
    dates: { zh: '7/4 - 7/7', en: 'Jul 4 - Jul 7' },
    matches: 8,
    detail: { zh: '强队交叉区开始显著影响争冠路径。', en: 'Cross-bracket path starts to shape title probability.' }
  },
  {
    id: 'qf',
    title: { zh: '四分之一决赛', en: 'Quarter-finals' },
    dates: { zh: '7/9 - 7/11', en: 'Jul 9 - Jul 11' },
    matches: 4,
    detail: { zh: '模型重点看赛程消耗、伤停和临场赔率。', en: 'Model focus shifts to fatigue, injuries and late market movement.' }
  },
  {
    id: 'sf',
    title: { zh: '半决赛', en: 'Semi-finals' },
    dates: { zh: '7/14 - 7/15', en: 'Jul 14 - Jul 15' },
    matches: 2,
    detail: { zh: '路径强度和阵容深度权重提高。', en: 'Route strength and squad depth carry more weight.' }
  },
  {
    id: 'third',
    title: { zh: '三四名', en: 'Third-place' },
    dates: { zh: '7/18', en: 'Jul 18' },
    matches: 1,
    detail: { zh: '战意和轮换风险高，不按常规淘汰赛强度处理。', en: 'Motivation and rotation risk are unusually high.' }
  },
  {
    id: 'final',
    title: { zh: '决赛', en: 'Final' },
    dates: { zh: '7/19', en: 'Jul 19' },
    matches: 1,
    detail: { zh: '最终预测只保留赛前锁定版本，赛后只做复盘。', en: 'Final forecast stays locked pre-match; post-match only reviews it.' }
  }
];

export const WORLD_CUP_PIPELINE_CARDS = [
  {
    title: { zh: '赛前概率', en: 'Pre-match Probability' },
    value: { zh: '胜平负 / 比分 / 大小球', en: '1X2 / score / goals' },
    detail: {
      zh: '沿用赔率基准、Elo、进球模型和风险标签，不只押热门。',
      en: 'Uses market baseline, Elo, goal model and risk tags instead of leaning only on favourites.'
    }
  },
  {
    title: { zh: 'SP 走势', en: 'SP Movement' },
    value: { zh: '快照留痕', en: 'Snapshot trail' },
    detail: {
      zh: '每次同步保存官方 SP，开赛后锁定预测，赛后按当时快照复盘。',
      en: 'Official SP snapshots are retained; picks lock after kickoff and review uses pre-match data.'
    }
  },
  {
    title: { zh: '晋级路径', en: 'Route Model' },
    value: { zh: '小组 -> 决赛', en: 'Groups -> Final' },
    detail: {
      zh: '已接入 12 组基准预测、最佳第三候选和淘汰赛争冠路径。',
      en: 'Covers all 12 group baselines, best-third candidates and knockout title routes.'
    }
  },
  {
    title: { zh: '赛后复盘', en: 'Post-match Review' },
    value: { zh: '命中率 + 校准', en: 'Hit rate + calibration' },
    detail: {
      zh: '保留历史分析，不用赛后信息回改预测，避免虚假提高准确率。',
      en: 'Keeps historical analysis unchanged and avoids post-match rewrites that inflate accuracy.'
    }
  }
];

export const WORLD_CUP_CONTENT_LANES = [
  {
    status: { zh: '已上线', en: 'Live' },
    title: { zh: '世界杯首页推荐', en: 'Home Spotlight' },
    items: {
      zh: ['首页专栏入口', '当前观察场次', 'SP 与模型倾向'],
      en: ['Home entry', 'Watch matches', 'SP and model lean']
    }
  },
  {
    status: { zh: '已接入', en: 'Live' },
    title: { zh: '赛前分析内容', en: 'Pre-match Analysis' },
    items: {
      zh: ['小组赛预测', '淘汰赛路径', '冠军候选观察'],
      en: ['Group forecasts', 'Knockout routes', 'Contender watch']
    }
  },
  {
    status: { zh: '持续校准', en: 'Calibrating' },
    title: { zh: '世界杯正赛数据', en: 'Tournament Data' },
    items: {
      zh: ['竞彩 SP 接入', '伤停首发更新', '赛后复盘评分'],
      en: ['Sporttery SP merge', 'Injury and lineup updates', 'Post-match scoring']
    }
  }
];

export interface WorldCupContender {
  teamId: string;
  matchId: string;
  opponentId: string;
  score: number;
  support: number | null;
  trust: number;
  reason: MultiLangString;
}

export interface WorldCupUpsetRadar {
  matchId: string;
  favoriteTeamId: string;
  underdogTeamId: string;
  favoriteSupport: number;
  underdogOdds: number;
  riskScore: number;
  reason: MultiLangString;
}

const WORLD_CUP_MATCH_PATTERN = /世界杯|世预|国际赛|国际|友谊|国家队|world cup|qualification|qualifier|international|friendly|fifa|national/i;

export function getBestPrediction(match: Match): PredictionDetail | undefined {
  return match.predictions.find((prediction) => prediction.marketType === 'BEST')
    || match.predictions.find((prediction) => prediction.marketType === '1X2');
}

export function getMatchTrust(match: Match): number {
  return getBestPrediction(match)?.trustScore || 0;
}

export function isWorldCupRelevantMatch(match: Match): boolean {
  const league = getLeagueById(match.leagueId);
  const text = [
    match.leagueId,
    match.countryId,
    match.leagueName,
    match.leagueNameEn,
    match.leagueShortName,
    match.leagueShortNameEn,
    match.countryName,
    match.countryNameEn,
    league.name.zh,
    league.name.en,
    league.shortName.zh,
    league.shortName.en
  ].filter(Boolean).join(' ');

  return WORLD_CUP_MATCH_PATTERN.test(text);
}

export function getWorldCupWatchMatches(matches: Match[], max = 6): Match[] {
  const active = matches.filter((match) => match.status !== 'FINISHED');
  const relevant = active.filter(isWorldCupRelevantMatch);
  const source = relevant.length > 0 ? relevant : active;

  return [...source]
    .sort((a, b) => {
      const timeDiff = new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime();
      if (timeDiff !== 0) return timeDiff;
      return getMatchTrust(b) - getMatchTrust(a);
    })
    .slice(0, max);
}

export function getWorldCupRecentResults(matches: Match[], max = 4): Match[] {
  const relevantFinished = matches.filter((match) => match.status === 'FINISHED' && isWorldCupRelevantMatch(match));
  const source = relevantFinished.length > 0
    ? relevantFinished
    : matches.filter((match) => match.status === 'FINISHED');

  return [...source]
    .sort((a, b) => new Date(b.kickoffTime).getTime() - new Date(a.kickoffTime).getTime())
    .slice(0, max);
}

export function getDaysUntilWorldCup(now = new Date()): number {
  const start = new Date(`${WORLD_CUP_OFFICIAL.startDate}T00:00:00-05:00`).getTime();
  const diff = start - now.getTime();
  return Math.max(0, Math.ceil(diff / 86_400_000));
}

const clamp = (value: number, min = 0, max = 99) => Math.min(max, Math.max(min, value));

const round1 = (value: number) => Math.round(value * 10) / 10;

const getTeamStrengthScore = (team: WorldCupTeamSeed, groupId: string): number => {
  const hostBoost = team.isHost ? 8 : 0;
  const debutPenalty = team.isDebut ? -2 : 0;
  const groupVarianceBoost = ['C', 'D', 'F', 'G', 'I', 'L'].includes(groupId) ? 1.4 : 0;
  return 104 - team.fifaRank * 0.86 + hostBoost + debutPenalty + groupVarianceBoost;
};

const getRouteLabel = (rank: number, advanceProbability: number): MultiLangString => {
  if (rank === 1) return { zh: '头名倾向', en: 'Projected group winner' };
  if (rank === 2) return { zh: '直接出线区', en: 'Direct qualification lane' };
  if (advanceProbability >= 48) return { zh: '最佳第三竞争', en: 'Best-third contender' };
  return { zh: '出局风险区', en: 'Elimination risk' };
};

const getSignal = (team: WorldCupTeamSeed, rank: number): MultiLangString => {
  if (team.isHost) {
    return {
      zh: '主场加成已计入，但东道主热度可能带来盘口过热。',
      en: 'Host boost is included, but market heat can still overprice them.'
    };
  }
  if (team.isDebut) {
    return {
      zh: '世界杯新军样本少，预测波动会比传统强队更大。',
      en: 'Debutant sample is thin, so forecast variance is higher.'
    };
  }
  if (rank <= 2) {
    return {
      zh: '基准强度处在小组前二，后续重点看伤停和首战赔率变化。',
      en: 'Baseline strength sits in the top two; injuries and opening-market movement matter next.'
    };
  }
  return team.note;
};

export function getWorldCupGroupForecasts(): WorldCupGroupForecast[] {
  return WORLD_CUP_GROUPS.map((group) => {
    const sorted = group.teams
      .map((team) => ({
        team,
        strengthScore: getTeamStrengthScore(team, group.id)
      }))
      .sort((a, b) => b.strengthScore - a.strengthScore);

    const totalWeight = sorted.reduce((sum, item) => sum + Math.exp(item.strengthScore / 15), 0);
    const secondScore = sorted[1]?.strengthScore ?? sorted[0]?.strengthScore ?? 0;
    const thirdScore = sorted[2]?.strengthScore ?? secondScore - 10;

    const teams: WorldCupTeamForecast[] = sorted.map((item, index) => {
      const projectedRank = index + 1;
      const groupWinProbability = clamp(Math.round((Math.exp(item.strengthScore / 15) / totalWeight) * 100), 2, 88);
      const directBase = [88, 70, 24, 8][index] ?? 5;
      const directAdjust = index <= 1
        ? (item.strengthScore - secondScore) * 0.34
        : (item.strengthScore - thirdScore) * 0.22;
      const directProbability = clamp(Math.round(directBase + directAdjust), 4, 94);
      const thirdBase = index === 2
        ? clamp(Math.round(42 + (item.strengthScore - thirdScore) * 0.4), 24, 68)
        : index === 3
          ? clamp(Math.round(10 + (item.strengthScore - thirdScore) * 0.24), 4, 26)
          : 0;
      const advanceProbability = clamp(directProbability + thirdBase, 4, 97);
      const pointsBase = [6.6, 5.2, 3.7, 1.7][index] ?? 1.5;
      const projectedPoints = round1(clamp(pointsBase + (item.strengthScore - secondScore) / 18, 0.8, 8.1));

      return {
        ...item.team,
        groupId: group.id,
        projectedRank,
        projectedPoints,
        groupWinProbability,
        advanceProbability,
        routeLabel: getRouteLabel(projectedRank, advanceProbability),
        signal: getSignal(item.team, projectedRank),
        strengthScore: item.strengthScore
      };
    });

    return {
      id: group.id,
      dates: group.dates,
      venueHint: group.venueHint,
      headline: group.headline,
      teams
    };
  });
}

export function getWorldCupProjectedQualifiers(groupForecasts = getWorldCupGroupForecasts()) {
  const winners: WorldCupTeamForecast[] = [];
  const runnersUp: WorldCupTeamForecast[] = [];
  const thirdPlaced: WorldCupTeamForecast[] = [];

  groupForecasts.forEach((group) => {
    const first = group.teams.find((team) => team.projectedRank === 1);
    const second = group.teams.find((team) => team.projectedRank === 2);
    const third = group.teams.find((team) => team.projectedRank === 3);
    if (first) winners.push(first);
    if (second) runnersUp.push(second);
    if (third) thirdPlaced.push(third);
  });

  const bestThird = [...thirdPlaced]
    .sort((a, b) => b.advanceProbability - a.advanceProbability || b.strengthScore - a.strengthScore)
    .slice(0, 8);

  return {
    winners,
    runnersUp,
    bestThird
  };
}

export function getWorldCupKnockoutForecast(groupForecasts = getWorldCupGroupForecasts()): WorldCupRouteForecast[] {
  const qualifiers = getWorldCupProjectedQualifiers(groupForecasts);
  const seededTeams = [...qualifiers.winners, ...qualifiers.runnersUp, ...qualifiers.bestThird]
    .sort((a, b) => b.strengthScore - a.strengthScore);
  const championDenominator = seededTeams.reduce((sum, team) => sum + Math.exp(team.strengthScore / 13), 0);

  return seededTeams.slice(0, 16).map((team, index) => {
    const titleBase = Math.exp(team.strengthScore / 13) / championDenominator;
    const round32 = clamp(team.advanceProbability, 20, 98);
    const round16 = clamp(Math.round(round32 * (0.78 - index * 0.012)), 12, 86);
    const quarterFinal = clamp(Math.round(round16 * (0.68 - index * 0.009)), 7, 70);
    const semiFinal = clamp(Math.round(quarterFinal * (0.54 - index * 0.006)), 4, 52);
    const final = clamp(Math.round(semiFinal * (0.46 - index * 0.004)), 2, 38);
    const champion = clamp(Math.round(titleBase * 100), 1, 24);
    const tier = champion >= 10
      ? { zh: '争冠第一档', en: 'Title tier' }
      : champion >= 6
        ? { zh: '四强候选', en: 'Semi-final tier' }
        : { zh: '八强路径', en: 'Quarter-final route' };

    return {
      team,
      round32,
      round16,
      quarterFinal,
      semiFinal,
      final,
      champion,
      tier
    };
  });
}

const teamReason = (teamId: string, support: number | null, trust: number): MultiLangString => {
  const team = getTeamById(teamId);
  const supportText = support === null ? '--' : `${support}%`;
  const trustText = trust ? `${trust}%` : '--';

  return {
    zh: `${team.shortName.zh} 当前 SP 支持率 ${supportText}，模型可信 ${trustText}，先列入世界杯观察池。`,
    en: `${team.shortName.en} is in the watch pool with SP support ${supportText} and model trust ${trustText}.`
  };
};

export function getWorldCupContenders(matches: Match[], max = 6): WorldCupContender[] {
  const active = getWorldCupWatchMatches(matches, 12);
  const byTeam = new Map<string, WorldCupContender>();

  active.forEach((match) => {
    const prediction = getBestPrediction(match);
    const trust = prediction?.trustScore || 0;
    const probabilities = getImpliedProbabilities(match.odds);
    const entries: Array<{ side: 'home' | 'away'; teamId: string; opponentId: string; support: number | null }> = [
      { side: 'home', teamId: match.homeTeamId, opponentId: match.awayTeamId, support: probabilities?.home ?? null },
      { side: 'away', teamId: match.awayTeamId, opponentId: match.homeTeamId, support: probabilities?.away ?? null }
    ];

    entries.forEach((entry) => {
      const support = entry.support ?? 42;
      const trendBoost = match.oddsTrend?.direction === entry.side ? 6 : 0;
      const score = clamp(Math.round(support * 0.58 + trust * 0.34 + trendBoost));
      const contender: WorldCupContender = {
        teamId: entry.teamId,
        opponentId: entry.opponentId,
        matchId: match.id,
        score,
        support: entry.support,
        trust,
        reason: teamReason(entry.teamId, entry.support, trust)
      };

      const existing = byTeam.get(entry.teamId);
      if (!existing || existing.score < contender.score) {
        byTeam.set(entry.teamId, contender);
      }
    });
  });

  return Array.from(byTeam.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

export function getWorldCupUpsetRadar(matches: Match[], max = 5): WorldCupUpsetRadar[] {
  return getWorldCupWatchMatches(matches, 16)
    .map((match) => {
      if (!match.odds) return null;

      const probabilities = getImpliedProbabilities(match.odds);
      if (!probabilities) return null;

      const sides = [
        { side: 'home' as const, teamId: match.homeTeamId, support: probabilities.home, odds: match.odds.odds1 },
        { side: 'away' as const, teamId: match.awayTeamId, support: probabilities.away, odds: match.odds.odds2 }
      ].sort((a, b) => b.support - a.support);

      const favorite = sides[0];
      const underdog = sides[1];
      if (!favorite || !underdog) return null;
      if (favorite.support < 44 && underdog.odds < 3.1) return null;

      const favoriteTeam = getTeamById(favorite.teamId);
      const underdogTeam = getTeamById(underdog.teamId);
      const trendPenalty = match.oddsTrend?.direction === 'mixed' ? 8 : 0;
      const lineBoost = match.handicapLine && match.handicapLine !== '0' ? 5 : 0;
      const riskScore = clamp(Math.round((100 - favorite.support) * 0.52 + underdog.odds * 7 + trendPenalty + lineBoost), 0, 95);

      return {
        matchId: match.id,
        favoriteTeamId: favorite.teamId,
        underdogTeamId: underdog.teamId,
        favoriteSupport: favorite.support,
        underdogOdds: underdog.odds,
        riskScore,
        reason: {
          zh: `${favoriteTeam.shortName.zh} 热度 ${favorite.support}%，${underdogTeam.shortName.zh} SP ${underdog.odds.toFixed(2)}，重点看让球与临场降赔。`,
          en: `${favoriteTeam.shortName.en} has ${favorite.support}% market support; ${underdogTeam.shortName.en} sits at SP ${underdog.odds.toFixed(2)}. Track handicap and late movement.`
        }
      };
    })
    .filter((item): item is WorldCupUpsetRadar => Boolean(item))
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, max);
}

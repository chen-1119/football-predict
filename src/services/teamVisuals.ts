import type { Team } from './mockData';
import crestCatalog from './teamCrestCatalog.json';
import { teamBadgeAssets } from './teamBadgeAssets';

export type TeamVisualType = 'flag' | 'crest' | 'crest-placeholder';

export type TeamVisual = {
  logo: string;
  candidates: string[];
  source: string;
  nativeFlag: string;
  label: string;
  fallbackText: string;
  logoType: TeamVisualType;
  isImage: boolean;
};

const CLUB_CREST_BY_NAME: Record<string, string> = {
  'acoulu': 'https://upload.wikimedia.org/wikipedia/commons/d/d5/AC_Oulu_logo.svg',
  'ffjaro': 'https://upload.wikimedia.org/wikipedia/en/9/9f/FF_Jaro_logotype.svg',
  'gnistan': 'https://upload.wikimedia.org/wikipedia/commons/d/d0/IF_Gnistan_logo.svg',
  'hjkhelsinki': 'https://media.api-sports.io/football/teams/649.png',
  'ifgnistan': 'https://upload.wikimedia.org/wikipedia/commons/d/d0/IF_Gnistan_logo.svg',
  'ifkmariehamn': 'https://upload.wikimedia.org/wikipedia/en/0/00/IFK_Mariehamnin_logo.svg',
  'ilves': 'https://media.api-sports.io/football/teams/1163.png',
  'interturku': 'https://media.api-sports.io/football/teams/1164.png',
  'kups': 'https://media.api-sports.io/football/teams/1165.png',
  'lahti': 'https://media.api-sports.io/football/teams/1166.png',
  'sjk': 'https://media.api-sports.io/football/teams/689.png',
  'tps': 'https://upload.wikimedia.org/wikipedia/en/3/30/Turun_Palloseura_logo.png',
  'tpsturku': 'https://upload.wikimedia.org/wikipedia/en/3/30/Turun_Palloseura_logo.png',
  'turunpalloseura': 'https://upload.wikimedia.org/wikipedia/en/3/30/Turun_Palloseura_logo.png',
  'vps': 'https://media.api-sports.io/football/teams/650.png',
  'AC奥卢': 'https://upload.wikimedia.org/wikipedia/commons/d/d5/AC_Oulu_logo.svg',
  'TPS图尔库': 'https://upload.wikimedia.org/wikipedia/en/3/30/Turun_Palloseura_logo.png',
  '国际图尔库': 'https://media.api-sports.io/football/teams/1164.png',
  '坦佩雷山猫': 'https://media.api-sports.io/football/teams/1163.png',
  '塞伊奈约基': 'https://media.api-sports.io/football/teams/689.png',
  '库奥皮奥': 'https://media.api-sports.io/football/teams/1165.png',
  '拉赫蒂': 'https://media.api-sports.io/football/teams/1166.png',
  '瓦萨': 'https://media.api-sports.io/football/teams/650.png',
  '玛丽港': 'https://upload.wikimedia.org/wikipedia/en/0/00/IFK_Mariehamnin_logo.svg',
  '赫尔辛基': 'https://media.api-sports.io/football/teams/649.png',
  '赫尔辛基火花': 'https://upload.wikimedia.org/wikipedia/commons/d/d0/IF_Gnistan_logo.svg',
  '雅罗': 'https://upload.wikimedia.org/wikipedia/en/9/9f/FF_Jaro_logotype.svg',
  albirexniigata: '/team-logos/jleague/albirex-niigata.png',
  avispafukuoka: '/team-logos/jleague/avispa-fukuoka.png',
  cerezoosaka: '/team-logos/jleague/cerezo-osaka.png',
  consadolesapporo: '/team-logos/jleague/consadole-sapporo.png',
  fagianookayama: '/team-logos/jleague/fagiano-okayama.png',
  fctokyo: '/team-logos/jleague/fc-tokyo.png',
  gambaosaka: '/team-logos/jleague/gamba-osaka.png',
  'jubilo iwata': '/team-logos/jleague/jubilo-iwata.png',
  jubiloiwata: '/team-logos/jleague/jubilo-iwata.png',
  jubilooiwata: '/team-logos/jleague/jubilo-iwata.png',
  jubilo: '/team-logos/jleague/jubilo-iwata.png',
  kashimaantlers: '/team-logos/jleague/kashima-antlers.png',
  kashiwareysol: '/team-logos/jleague/kashiwa-reysol.png',
  kawasakifrontale: '/team-logos/jleague/kawasaki-frontale.png',
  kyotosanga: '/team-logos/jleague/kyoto-sanga.png',
  machidazelvia: '/team-logos/jleague/machida-zelvia.png',
  nagoyagrampus: '/team-logos/jleague/nagoya-grampus.png',
  sagantosu: '/team-logos/jleague/sagan-tosu.png',
  sanfreccehiroshima: '/team-logos/jleague/sanfrecce-hiroshima.png',
  shimizuspulse: '/team-logos/jleague/shimizu-s-pulse.png',
  shonanbellmare: '/team-logos/jleague/shonan-bellmare.png',
  'tokyo verdy': '/team-logos/jleague/tokyo-verdy.png',
  tokyoverdy: '/team-logos/jleague/tokyo-verdy.png',
  urawarediamonds: '/team-logos/jleague/urawa-red-diamonds.png',
  visselkobe: '/team-logos/jleague/vissel-kobe.png',
  yokohamafmarinos: '/team-logos/jleague/yokohama-f-marinos.png',
  yokohamafc: '/team-logos/jleague/yokohama-fc.png',
  新泻天鹅: '/team-logos/jleague/albirex-niigata.png',
  福冈黄蜂: '/team-logos/jleague/avispa-fukuoka.png',
  大阪樱花: '/team-logos/jleague/cerezo-osaka.png',
  札幌冈萨多: '/team-logos/jleague/consadole-sapporo.png',
  冈山绿雉: '/team-logos/jleague/fagiano-okayama.png',
  东京fc: '/team-logos/jleague/fc-tokyo.png',
  大阪钢巴: '/team-logos/jleague/gamba-osaka.png',
  磐田喜悦: '/team-logos/jleague/jubilo-iwata.png',
  鹿岛鹿角: '/team-logos/jleague/kashima-antlers.png',
  柏太阳神: '/team-logos/jleague/kashiwa-reysol.png',
  川崎前锋: '/team-logos/jleague/kawasaki-frontale.png',
  京都不死鸟: '/team-logos/jleague/kyoto-sanga.png',
  町田泽维亚: '/team-logos/jleague/machida-zelvia.png',
  名古屋鲸八: '/team-logos/jleague/nagoya-grampus.png',
  鸟栖沙岩: '/team-logos/jleague/sagan-tosu.png',
  广岛三箭: '/team-logos/jleague/sanfrecce-hiroshima.png',
  清水鼓动: '/team-logos/jleague/shimizu-s-pulse.png',
  湘南海洋: '/team-logos/jleague/shonan-bellmare.png',
  东京绿茵: '/team-logos/jleague/tokyo-verdy.png',
  浦和红钻: '/team-logos/jleague/urawa-red-diamonds.png',
  神户胜利船: '/team-logos/jleague/vissel-kobe.png',
  横滨水手: '/team-logos/jleague/yokohama-f-marinos.png',
  横滨fc: '/team-logos/jleague/yokohama-fc.png'
};

const FLAG_CODE_BY_NAME: Record<string, string> = {
  philippines: 'ph', 菲律宾: 'ph',
  unitedarabemirates: 'ae', uae: 'ae', 阿联酋: 'ae',
  maldives: 'mv', 马尔代夫: 'mv',
  vietnam: 'vn', 越南: 'vn',
  indonesia: 'id', 印度尼西亚: 'id', 印尼: 'id',
  malaysia: 'my', 马来西亚: 'my',
  hongkong: 'hk', 中国香港: 'hk', 香港: 'hk',
  macau: 'mo', macao: 'mo', 中国澳门: 'mo', 澳门: 'mo',
  northkorea: 'kp', 朝鲜: 'kp',
  kosovo: 'xk', 科索沃: 'xk',
  argentina: 'ar',
  algeria: 'dz',
  australia: 'au',
  austria: 'at',
  cv: 'cv',
  cvi: 'cv',
  curacao: 'cw',
  cotedivoire: 'ci',
  egy: 'eg',
  belgium: 'be',
  bolivia: 'bo',
  bosnia: 'ba',
  bosniaandherzegovina: 'ba',
  brazil: 'br',
  bulgaria: 'bg',
  canada: 'ca',
  chile: 'cl',
  china: 'cn',
  colombia: 'co',
  costarica: 'cr',
  crc: 'cr',
  croatia: 'hr',
  cyprus: 'cy',
  czechia: 'cz',
  czechrepublic: 'cz',
  denmark: 'dk',
  ecuador: 'ec',
  egypt: 'eg',
  england: 'gb-eng',
  finland: 'fi',
  france: 'fr',
  georgia: 'ge',
  germany: 'de',
  ghana: 'gh',
  greece: 'gr',
  haiti: 'ht',
  hat: 'ht',
  hungary: 'hu',
  iceland: 'is',
  ira: 'ir',
  ireland: 'ie',
  iran: 'ir',
  iraq: 'iq',
  italy: 'it',
  japan: 'jp',
  jordan: 'jo',
  kazakhstan: 'kz',
  korea: 'kr',
  korearepublic: 'kr',
  mexico: 'mx',
  montenegro: 'me',
  mco: 'ma',
  morocco: 'ma',
  netherlands: 'nl',
  northernireland: 'gb-nir',
  northmacedonia: 'mk',
  norway: 'no',
  nigeria: 'ng',
  panama: 'pa',
  paraguay: 'py',
  pgy: 'py',
  peru: 'pe',
  poland: 'pl',
  portugal: 'pt',
  qatar: 'qa',
  romania: 'ro',
  rsa: 'za',
  sar: 'sa',
  saudiarabia: 'sa',
  scotland: 'gb-sct',
  serbia: 'rs',
  senegal: 'sn',
  singapore: 'sg',
  slovakia: 'sk',
  slovenia: 'si',
  spain: 'es',
  southafrica: 'za',
  sweden: 'se',
  switzerland: 'ch',
  thailand: 'th',
  tunisia: 'tn',
  turkey: 'tr',
  uruguay: 'uy',
  usa: 'us',
  unitedstates: 'us',
  uzbekistan: 'uz',
  venezuela: 've',
  wales: 'gb-wls',
  阿根廷: 'ar',
  澳大利亚: 'au',
  奥地利: 'at',
  比利时: 'be',
  玻利: 'bo',
  玻利维亚: 'bo',
  巴西: 'br',
  保加利亚: 'bg',
  佛得角: 'cv',
  加拿大: 'ca',
  智利: 'cl',
  中国: 'cn',
  哥伦比亚: 'co',
  哥斯达: 'cr',
  哥斯达黎加: 'cr',
  克罗地亚: 'hr',
  库拉索: 'cw',
  塞浦路斯: 'cy',
  丹麦: 'dk',
  刚果民主共和国: 'cd',
  刚果金: 'cd',
  厄瓜多尔: 'ec',
  埃及: 'eg',
  英格兰: 'gb-eng',
  芬兰: 'fi',
  法国: 'fr',
  格鲁吉亚: 'ge',
  德国: 'de',
  加纳: 'gh',
  希腊: 'gr',
  海地: 'ht',
  匈牙利: 'hu',
  冰岛: 'is',
  科特迪瓦: 'ci',
  爱尔兰: 'ie',
  伊朗: 'ir',
  伊拉克: 'iq',
  意大利: 'it',
  日本: 'jp',
  约旦: 'jo',
  哈萨: 'kz',
  哈萨克斯坦: 'kz',
  韩国: 'kr',
  墨西哥: 'mx',
  捷克: 'cz',
  黑山: 'me',
  摩洛: 'ma',
  摩洛哥: 'ma',
  荷兰: 'nl',
  北爱尔兰: 'gb-nir',
  北马其顿: 'mk',
  挪威: 'no',
  尼日利亚: 'ng',
  巴拿马: 'pa',
  巴拉圭: 'py',
  秘鲁: 'pe',
  波兰: 'pl',
  葡萄牙: 'pt',
  卡塔尔: 'qa',
  罗马尼亚: 'ro',
  沙特: 'sa',
  沙特阿拉伯: 'sa',
  苏格兰: 'gb-sct',
  塞尔维亚: 'rs',
  塞内加尔: 'sn',
  新加坡: 'sg',
  斯洛伐克: 'sk',
  斯洛文尼亚: 'si',
  西班牙: 'es',
  南非: 'za',
  瑞典: 'se',
  瑞士: 'ch',
  泰国: 'th',
  突尼斯: 'tn',
  土耳其: 'tr',
  乌拉圭: 'uy',
  美国: 'us',
  乌兹别克: 'uz',
  乌兹别克斯坦: 'uz',
  委内: 've',
  委内瑞拉: 've',
  威尔士: 'gb-wls',
  新西兰: 'nz'
};

const FALLBACK_TEAM: Team = {
  id: 'unknown',
  name: { zh: '未知球队', en: 'Unknown Team' },
  shortName: { zh: '未知', en: 'Unknown' },
  logo: '?',
  value: '-',
  color: '#64748b'
};


export const isImageLogo = (logo: string) => /^(https?:\/\/[^/]|\/(?!\/)|\.\/)/i.test(logo) || /^data:image\/(?:png|webp|jpeg);base64,[a-z0-9+/]+=*$/i.test(logo);
export const isFlagEmoji = (logo: string) => /\p{Regional_Indicator}/u.test(logo);

const normalizeToken = (value?: string) => String(value || '').trim().toLowerCase()
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, '').replace(/[·.()（）'’\-_/]/g, '');
const countryToken = (value?: string) => normalizeToken(value)
  .replace(/(?:国家队|nationalteam|亚运会?(?:男足|女足|男子|女子)?|亚运(?:男足|女足|男子|女子)?|亚足|男足|女足|男子|女子|women|woman|men|u\d{2}|under\d{2}|队)+$/gi, '');
const isoFromFlagUrl = (value?: string) => String(value || '').match(/^https:\/\/flagcdn\.com\/(?:w\d+\/)?([a-z]{2}(?:-[a-z]{3})?)\.(?:png|svg|webp)$/i)?.[1]?.toLowerCase() || '';
const validCountryCodes = new Set([...Object.values(FLAG_CODE_BY_NAME), 'xk']);
const flagEmojiForCode = (code: string) => /^[a-z]{2}$/i.test(code)
  ? Array.from(code.toUpperCase()).map(char => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65)).join('') : '';
const regionalFlag = (...tags: number[]) => String.fromCodePoint(0x1f3f4, ...tags, 0xe007f);
const flagFallbackForCode = (code: string) => ({
  'gb-eng': regionalFlag(0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067),
  'gb-sct': regionalFlag(0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074),
  'gb-wls': regionalFlag(0xe0067, 0xe0062, 0xe0077, 0xe006c, 0xe0073),
  'gb-nir': '🇬🇧',
} as Record<string, string>)[code] || flagEmojiForCode(code);
const flagUrl = (code: string) => 'https://flagcdn.com/w80/' + code + '.png';
const namesOf = (team: Team) => [team.name.zh, team.name.en, team.shortName.zh, team.shortName.en];
const catalogByName = new Map(crestCatalog.flatMap(entry => entry.aliases.map(alias => [normalizeToken(alias), entry] as const)));
const legacyByName = new Map(Object.entries(CLUB_CREST_BY_NAME).map(([name, url]) => [normalizeToken(name), url]));

export function resolveCountryIso(...values: Array<string | undefined>) {
  for (const value of values) {
    const raw = String(value || '').trim();
    const fromUrl = isoFromFlagUrl(raw);
    if (fromUrl) return fromUrl;
    const normalized = countryToken(raw);
    const known = FLAG_CODE_BY_NAME[raw] || FLAG_CODE_BY_NAME[normalized];
    if (known) return known;
    if (validCountryCodes.has(raw.toLowerCase())) return raw.toLowerCase();
  }
  return '';
}

export function resolveTeamVisual(team?: Team): TeamVisual {
  const t = team ?? FALLBACK_TEAM;
  const raw = String(t.logo || '').trim();
  const names = namesOf(t);
  const label = t.shortName.zh || t.shortName.en || t.name.zh || t.name.en || '球队';
  // A shortened label may omit Women / U23. Full identity takes precedence.
  const restrictedCategory = /女足|女子|青年|少年|预备|二队|(?:women|ladies|youth|reserves?)\b|u[\s-]?\d{2}\b|under[\s-]?\d{2}\b/i.test(t.name.zh + ' ' + t.name.en);
  const clubNames = restrictedCategory ? [] : names;
  const entry = clubNames.map(name => catalogByName.get(normalizeToken(name))).find(Boolean);
  const legacy = clubNames.map(name => legacyByName.get(normalizeToken(name))).find(Boolean) || '';
  const image = isImageLogo(raw) ? raw : '';
  // Country metadata is not a club crest. Only a confirmed country name or
  // explicitly typed national-team flag can choose a country illustration.
  const namedIso = resolveCountryIso(...names.filter(name => !/^[a-z]{2}$/i.test(name)));
  const iso = entry || legacy ? '' : namedIso || (t.logoType === 'flag' ? resolveCountryIso(raw) : '');
  const logoType: TeamVisualType = entry || legacy ? 'crest' : iso || isFlagEmoji(raw) || t.logoType === 'flag' ? 'flag' : image ? 'crest' : 'crest-placeholder';
  const cached = entry ? teamBadgeAssets[entry.key] : iso ? teamBadgeAssets['flag-' + iso] : '';
  const candidates = [...new Set([cached,
    // A supplied image is tried only within the resolved identity category.
    logoType === 'crest' && isoFromFlagUrl(image) ? '' : image,
    entry?.logoUrl, legacy, iso ? flagUrl(iso) : '',
  ].filter((value): value is string => Boolean(value && isImageLogo(value))))];
  const nativeFlag = iso ? flagFallbackForCode(iso) : isFlagEmoji(raw) ? raw : '';
  return { logo: candidates[0] || nativeFlag, candidates, source: entry?.provider || (iso ? 'flagpedia' : legacy ? 'known-club' : image ? 'match-source' : 'unavailable'),
    label, fallbackText: nativeFlag, nativeFlag, logoType, isImage: candidates.length > 0 };
}

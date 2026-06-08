import type { Team } from './mockData';

export type TeamVisualType = 'flag' | 'crest' | 'crest-placeholder';

type TeamVisual = {
  logo: string;
  label: string;
  fallbackText: string;
  logoType: TeamVisualType;
  isImage: boolean;
};

const CLUB_CREST_BY_NAME: Record<string, string> = {
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

export const isImageLogo = (logo: string) => /^(https?:\/\/|\/|\.\/)/.test(logo);
export const isFlagEmoji = (logo: string) => /\p{Regional_Indicator}/u.test(logo);

const normalizeToken = (value?: string) => (
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .replace(/[·.()（）'’\-_/]/g, '')
    .replace(/国家队|男子|男足|女子|女足|队$/g, '')
);

const isoFromFlagUrl = (value?: string) => {
  const match = String(value || '').match(/flagcdn\.com\/(?:w\d+\/)?([a-z]{2}(?:-[a-z]{3})?)\.png/i);
  return match?.[1]?.toLowerCase() || '';
};
const FLAG_FALLBACK_BY_CODE: Record<string, string> = {
  'gb-eng': 'ENG',
  'gb-nir': 'NIR',
  'gb-sct': 'SCO',
  'gb-wls': 'WAL',
  xk: 'XK'
};
const flagFallbackForCode = (code: string) => {
  const normalized = code.toLowerCase();
  const mapped = FLAG_FALLBACK_BY_CODE[normalized];
  if (mapped) return mapped;
  return code.toUpperCase();
};
const flagUrl = (code: string) => `https://flagcdn.com/w80/${code.toLowerCase()}.png`;
const findClubCrest = (...values: Array<string | undefined>) => {
  for (const value of values) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    const direct = CLUB_CREST_BY_NAME[raw] || CLUB_CREST_BY_NAME[normalizeToken(raw)];
    if (direct) return direct;
  }
  return '';
};

export function resolveCountryIso(...values: Array<string | undefined>) {
  for (const value of values) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    const fromFlagUrl = isoFromFlagUrl(raw);
    if (fromFlagUrl) return fromFlagUrl;
    const normalized = normalizeToken(raw);
    const direct = FLAG_CODE_BY_NAME[raw] || FLAG_CODE_BY_NAME[normalized];
    if (direct) return direct;
    if (/^[a-z]{2}(-[a-z]{3})?$/i.test(raw)) return raw.toLowerCase();
  }
  return '';
}

function initialsFromTeam(team: Team) {
  const english = team.shortName.en || team.name.en;
  if (english && /^[a-z0-9\s.-]+$/i.test(english)) {
    return english
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0))
      .join('')
      .toUpperCase() || '?';
  }

  const chinese = team.shortName.zh || team.name.zh || team.logo || '?';
  return Array.from(chinese).slice(0, 2).join('');
}

export function resolveTeamVisual(team?: Team): TeamVisual {
  const safeTeam = team ?? FALLBACK_TEAM;
  const rawLogo = safeTeam.logo || '';
  const label = safeTeam.shortName.zh || safeTeam.shortName.en || safeTeam.name.zh || safeTeam.name.en || '球队';
  const fallbackText = initialsFromTeam(safeTeam);
  const isoFromName = resolveCountryIso(safeTeam.shortName.zh, safeTeam.name.zh, safeTeam.shortName.en, safeTeam.name.en);
  const clubCrest = findClubCrest(safeTeam.shortName.zh, safeTeam.name.zh, safeTeam.shortName.en, safeTeam.name.en, rawLogo);

  if (isoFromName && (safeTeam.logoType === 'flag' || rawLogo.includes('flagcdn.com') || !isImageLogo(rawLogo))) {
    return {
      logo: flagUrl(isoFromName),
      label,
      fallbackText: flagFallbackForCode(isoFromName),
      logoType: 'flag',
      isImage: true
    };
  }

  if (clubCrest && !rawLogo.includes('flagcdn.com')) {
    return {
      logo: clubCrest,
      label,
      fallbackText,
      logoType: 'crest',
      isImage: true
    };
  }

  if (isImageLogo(rawLogo)) {
    const flagIso = isoFromFlagUrl(rawLogo);
    if (flagIso) {
      return {
        logo: rawLogo,
        label,
        fallbackText: flagFallbackForCode(flagIso),
        logoType: 'flag',
        isImage: true
      };
    }

    return {
      logo: rawLogo,
      label,
      fallbackText,
      logoType: safeTeam.logoType || (rawLogo.includes('flagcdn.com') ? 'flag' : 'crest'),
      isImage: true
    };
  }

  if (isFlagEmoji(rawLogo)) {
    return {
      logo: rawLogo,
      label,
      fallbackText,
      logoType: 'flag',
      isImage: false
    };
  }

  const iso = resolveCountryIso(rawLogo);
  if (iso) {
    return {
      logo: flagUrl(iso),
      label,
      fallbackText: flagFallbackForCode(iso),
      logoType: 'flag',
      isImage: true
    };
  }

  return {
    logo: fallbackText,
    label,
    fallbackText,
    logoType: safeTeam.logoType || 'crest-placeholder',
    isImage: false
  };
}

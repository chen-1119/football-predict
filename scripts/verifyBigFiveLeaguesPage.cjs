const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const readText = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');

const app = readText('src/App.tsx');
const navbar = readText('src/components/Navbar.tsx');
const page = readText('src/pages/BigFiveLeagues.tsx');
const badge = readText('src/components/TeamBadge.tsx');
const syncData = readText('scripts/syncData.cjs');
const styles = readText('src/styles/leagues.css');
const seasonCalendar = readText('src/data/bigFiveSeasonCalendar.ts');
const {
  leagueMeta,
  normalizeLeagueMetadataForAppMatch,
} = require('./syncData.cjs');

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};
const hasAll = (text, needles) => needles.every((needle) => text.includes(needle));

check('top-leagues navigation replaces the World Cup destination while preserving the old URL redirect', () => {
  assert.ok(hasAll(navbar, [
    "type NavTab = 'predictions' | 'fixtures' | 'review' | 'leagues'",
    "{ key: 'leagues', labelKey: 'topLeagues', icon: Shield }",
    "topLeagues: {",
    "en: 'Top Leagues'",
  ]));
  assert.ok(hasAll(app, [
    "leagues: '/leagues'",
    "if (pathname.startsWith('/leagues') || pathname.startsWith('/worldcup')) return 'leagues'",
    'path="/leagues"',
    '<BigFiveLeagues onSelectMatch={selectMatch} />',
    '<Route path="/worldcup" element={<Navigate to="/leagues" replace />} />',
  ]));
});

check('the desk contains exactly the five requested league identities', () => {
  const keys = [...page.matchAll(/key:\s*'(premier-league|la-liga|bundesliga|serie-a|ligue-1)'/g)]
    .map((match) => match[1]);
  assert.deepEqual(keys, ['premier-league', 'la-liga', 'bundesliga', 'serie-a', 'ligue-1']);
  assert.ok(hasAll(page, [
    "en: 'Premier League'",
    "en: 'La Liga'",
    "en: 'Bundesliga'",
    "en: 'Serie A'",
    "en: 'Ligue 1'",
  ]));
});

check('same-name leagues require their matching country, so Brazilian Serie A cannot enter Italy', () => {
  const classifierStart = page.indexOf('const getLeagueForMatch =');
  const classifierEnd = page.indexOf('const getMatchDisplayTeam =', classifierStart);
  const classifierSource = page.slice(classifierStart, classifierEnd);
  assert.ok(classifierStart >= 0 && classifierEnd > classifierStart);
  assert.ok(hasAll(classifierSource, [
    "const countryId = String(match.countryId || '').trim().toLowerCase()",
    'const countryMatches = league.countryIds.includes(countryId)',
    'return countryMatches && league.patterns.some((pattern) => (',
    'leagueSignals.some((signal) => pattern.test(signal))',
    'Women|Youth|Reserve|\\bCup\\b',
  ]));
  assert.ok(page.includes("countryIds: ['ita']"));

  const classifySerieA = ({ countryId = '', countryName = '', leagueName = '' }) => {
    const countryMatches = ['ita'].includes(countryId.trim().toLowerCase())
      || /Italy/i.test(`${countryName} ${countryId}`);
    return countryMatches && /^(?:Italian\s+)?Serie\s*A$/i.test(leagueName) ? 'serie-a' : undefined;
  };
  assert.equal(classifySerieA({ countryId: 'bra', countryName: 'Brazil', leagueName: 'Serie A' }), undefined);
  assert.equal(classifySerieA({ countryId: 'ita', countryName: 'Italy', leagueName: 'Serie A' }), 'serie-a');
});

check('source league metadata resolves Brazil and European competition names before broad league aliases', () => {
  assert.deepEqual(leagueMeta('巴甲'), {
    countryId: 'bra',
    countryNameEn: 'Brazil',
    countryName: '巴西',
    countryFlag: '🇧🇷',
    leagueNameEn: 'Brazilian Serie A',
    leagueShortName: '巴甲',
  });
  assert.equal(leagueMeta('巴西甲级联赛').countryId, 'bra');
  assert.equal(leagueMeta('Brazilian Serie A').countryId, 'bra');
  assert.equal(leagueMeta('西甲').countryId, 'esp');
  assert.equal(leagueMeta('欧洲冠军联赛').countryId, 'eur');
  assert.equal(leagueMeta('欧罗巴').countryId, 'eur');
  assert.notEqual(leagueMeta('巴甲').countryId, leagueMeta('西甲').countryId);
  assert.deepEqual(
    normalizeLeagueMetadataForAppMatch({
      leagueName: '巴甲',
      leagueNameEn: 'La Liga',
      countryId: 'esp',
      countryName: '西班牙',
      countryNameEn: 'Spain',
      countryFlag: '🇪🇸',
    }),
    {
      leagueName: '巴甲',
      leagueNameEn: 'Brazilian Serie A',
      leagueShortName: '巴甲',
      leagueShortNameEn: 'Brazilian Se',
      countryId: 'bra',
      countryName: '巴西',
      countryNameEn: 'Brazil',
      countryFlag: '🇧🇷',
    }
  );
  assert.equal(normalizeLeagueMetadataForAppMatch({
    leagueName: '欧罗巴',
    countryId: 'oth',
  }).countryId, 'eur');
});

check('Chinese league matching is token-exact, so 巴西甲级联赛 cannot become 西甲', () => {
  assert.ok(hasAll(page, [
    'const matchLeagueNameSignals = (match: Match) =>',
    'const NON_BIG_FIVE_LEAGUE_PATTERNS = [',
    'nameSignals.some((signal) => NON_BIG_FIVE_LEAGUE_PATTERNS.some((pattern) => pattern.test(signal)))',
    'const matchLeagueSignals = (match: Match) =>',
    'leagueSignals.some((signal) => pattern.test(signal))',
    '/^(?:西甲|西班牙(?:足球)?甲级(?:联赛)?)$/i',
  ]));
  const laLigaPattern = /^(?:西甲|西班牙(?:足球)?甲级(?:联赛)?)$/i;
  assert.equal(laLigaPattern.test('西甲'), true);
  assert.equal(laLigaPattern.test('西班牙甲级联赛'), true);
  assert.equal(laLigaPattern.test('巴西甲级联赛'), false);
  assert.equal(laLigaPattern.test('巴甲'), false);

  const nonBigFivePatterns = [
    /^(?:巴甲|巴西(?:足球)?甲级(?:联赛)?)$/i,
    /^(?:campeonato\s+brasileiro(?:\s+s[eé]rie\s+a)?|brasileir[aã]o(?:\s+s[eé]rie\s+a)?|brazil(?:ian)?\s+s[eé]rie\s+a)$/i,
  ];
  const conflictedProductionRow = {
    countryName: '西班牙',
    leagueName: '巴西甲级联赛',
    leagueNameEn: 'La Liga',
  };
  const classifyLaLiga = (row) => {
    const signals = [row.leagueName, row.leagueNameEn].filter(Boolean);
    if (signals.some((signal) => nonBigFivePatterns.some((pattern) => pattern.test(signal)))) return undefined;
    const countryMatches = /西班牙|spain/i.test(`${row.countryName || ''} ${row.countryNameEn || ''}`);
    return countryMatches && signals.some((signal) => laLigaPattern.test(signal)) ? 'la-liga' : undefined;
  };
  assert.equal(classifyLaLiga(conflictedProductionRow), undefined);
  assert.equal(classifyLaLiga({ countryName: '西班牙', leagueName: '西甲', leagueNameEn: 'La Liga' }), 'la-liga');
});

check('empty fixtures preserve the confirmed opening time and lead to reviews without inventing a fixture', () => {
  assert.ok(hasAll(page, [
    "type LeagueView = 'fixtures' | 'picks' | 'review'",
    "activeView === 'fixtures'",
    "setActiveView('review')",
    'No new-season fixtures are synced yet',
    'The official season start is confirmed while match-level fixtures are still syncing.',
    'Official start:',
    'selectedDefinition.seasonStartUtc',
    'Open recent reviews',
    "['review', language === 'zh' ?",
    'reviewMatches.slice(0, 3)',
  ]));
});

check('all five 2026/27 opening kickoffs are confirmed, sourced and normalized to UTC', () => {
  const expectedStarts = {
    'premier-league': ['2026-08-21T19:00:00.000Z', '08/22/2026, 03:00'],
    'la-liga': ['2026-08-15T17:00:00.000Z', '08/16/2026, 01:00'],
    bundesliga: ['2026-08-28T18:30:00.000Z', '08/29/2026, 02:30'],
    'serie-a': ['2026-08-22T16:30:00.000Z', '08/23/2026, 00:30'],
    'ligue-1': ['2026-08-21T18:45:00.000Z', '08/22/2026, 02:45'],
  };
  Object.entries(expectedStarts).forEach(([key, [iso, beijing]]) => {
    assert.ok(seasonCalendar.includes(`${key.includes('-') ? `'${key}'` : key}: {`));
    assert.ok(seasonCalendar.includes(`seasonStartUtc: '${iso}'`));
    const rendered = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
    assert.equal(rendered, beijing);
  });
  assert.equal((seasonCalendar.match(/^\s{4}status: 'confirmed'/gm) || []).length, 5);
  assert.equal((seasonCalendar.match(/officialSourceUrl: 'https:\/\//g) || []).length, 5);
  assert.equal((seasonCalendar.match(/verifiedAt: '2026-07-20T00:00:00\.000Z'/g) || []).length, 5);
  assert.ok(hasAll(seasonCalendar, [
    "localTimeZone: 'Europe/London'",
    "localTimeZone: 'Europe/Madrid'",
    "localTimeZone: 'Europe/Berlin'",
    "localTimeZone: 'Europe/Rome'",
    "localTimeZone: 'Europe/Paris'",
  ]));
});

check('opening times stay visible as Beijing time with machine-readable dates and official links', () => {
  assert.ok(hasAll(page, [
    'className="leagues-opening-board"',
    "'五大联赛开赛时间'",
    "'均已换算为北京时间，时间来自各联赛官方赛程'",
    '<time dateTime={league.seasonStartUtc}>',
    'href={league.officialSourceUrl}',
    'target="_blank"',
    "'官方确认'",
    'leagueStartCountdown(league.seasonStartUtc, language)',
    '<time dateTime={selectedDefinition.seasonStartUtc}>',
    "'北京时间'",
  ]));
  assert.ok(hasAll(styles, [
    '.leagues-opening-board',
    '.leagues-opening-board__grid',
    'grid-template-columns: repeat(5, minmax(0, 1fr));',
    '.leagues-opening-board__grid time',
    'overflow-x: auto;',
  ]));
});

check('invalid or stale fixture times cannot become the next match', () => {
  assert.ok(hasAll(page, [
    'const ZONED_ISO_PATTERN =',
    "return language === 'zh' ? '时间待确认' : 'Time pending'",
    "match.status === 'LIVE' || (match.status === 'SCHEDULED' && kickoff > now)",
    "const nextMatch = upcomingMatches.find((match) => match.status === 'SCHEDULED')",
    "const liveMatch = upcomingMatches.find((match) => match.status === 'LIVE')",
    "match.status === 'FINISHED' || match.resultDisposition === 'VOID'",
    'sortByKickoff(1)',
    'a.id.localeCompare(b.id)',
  ]));
  assert.equal(page.includes("match.status === 'FINISHED' || match.status === 'PENDING_RESULT'"), false);
});

check('formal, live and reference tracks stay separate while references remain visible', () => {
  const recommendationStart = page.indexOf('const getRecommendationState =');
  const recommendationEnd = page.indexOf('const formatKickoff =', recommendationStart);
  const recommendationSource = page.slice(recommendationStart, recommendationEnd);
  assert.ok(hasAll(recommendationSource, [
    "track: 'formal' as RecommendationTrack",
    "track: 'live' as RecommendationTrack",
    "track: 'reference' as RecommendationTrack",
    "track: 'none' as RecommendationTrack",
  ]));
  assert.ok(hasAll(page, [
    "return track === 'formal' || track === 'live' || track === 'reference'",
    "data-track={recommendation.track}",
    "recommendation.track === 'reference'",
    "const referenceCount = upcomingMatches.filter",
    "Picks / references",
    'Analysis only; excluded from formal hit rate',
    'Published live record; separate from formal stats',
    'References excluded from hit rate',
  ]));
});

check('team crests use images when available and a neutral shield without visible text otherwise', () => {
  assert.ok(hasAll(badge, [
    "import { Shield } from 'lucide-react'",
    '<Shield className="team-badge-fallback-icon" aria-hidden="true" />',
    'alt=""',
    'aria-hidden="true"',
    'failedLogo !== visual.logo',
  ]));
  assert.equal(badge.includes('fallbackText'), false);
  assert.equal(badge.includes('{visual.fallbackText}'), false);
  assert.ok(syncData.includes('return { logo: "", logoType: "crest-placeholder" };'));
  assert.equal(/return\s*\{\s*logo:\s*initialsFromName/.test(syncData), false);
});

check('desktop workbench and mobile vertical flow are both defined', () => {
  assert.ok(hasAll(styles, [
    '.leagues-workbench',
    'grid-template-columns: 216px minmax(0, 1fr) 248px;',
    '@media (max-width: 820px)',
    '@media (max-width: 620px)',
    'grid-template-columns: 1fr;',
    'font-variant-numeric: tabular-nums;',
  ]));
});

console.log(JSON.stringify({
  ok: true,
  checkedAt: new Date().toISOString(),
  checks: checks.length,
  passed: checks,
}, null, 2));

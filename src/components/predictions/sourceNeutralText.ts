type DisplayLanguage = 'zh' | 'en';

/** Presentation only: never pass the result back into evidence or prediction data. */
export function formatSourceNeutralText(
  value: string | null | undefined,
  language: DisplayLanguage,
  fallback = ''
): string {
  if (typeof value !== 'string' || !value) return fallback;
  const resultContext = /赛果|结算|比分记录|result|settlement/i.test(value);
  const weatherContext = /天气|weather/i.test(value);
  const marketContext = /赔率|盘口|均赔|odds|market/i.test(value);
  const neutral = language === 'zh'
    ? (resultContext ? '赛果记录' : weatherContext ? '天气数据' : marketContext ? '赔率参考' : '赛前数据')
    : (resultContext ? 'result records' : weatherContext ? 'weather data' : marketContext ? 'odds reference' : 'pre-match data');

  return value
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/\/)[^)]+\)/gi, '$1')
    .replace(/(["'])\\\\[^"'\r\n]+\1/g, neutral)
    .replace(/\\\\[^\s\\/<>"'，。；、（）【】\])]+[\\/][^\s<>"'，。；、（）【】\])]+/g, neutral)
    .replace(/(?:https?:\/\/|file:\/\/|www\.)[^\s<>"'，。；、（）【】\])]+/gi, neutral)
    .replace(/500(?:\.com)?(?:网)?\s*(赛前数据|数据|市场参考|参考价|近期战绩|赔率|市场)/gi, (_match, label: string) => (
      ({ 赛前数据: '赛前数据', 数据: '赛前数据', 市场参考: '市场参考', 参考价: '参考价', 近期战绩: '近期战绩', 赔率: '参考赔率', 市场: '参考市场' } as Record<string, string>)[label]
    ))
    .replace(/500\.com\s+(pre-match data|data|recent form|market reference|reference)/gi, (_match, label: string) => (
      ({ 'pre-match data': 'pre-match data', data: 'pre-match data', 'recent form': 'recent form', 'market reference': 'market reference', reference: 'reference' } as Record<string, string>)[label.toLowerCase()]
    ))
    .replace(/(?:500\.com|500网|five[-_ ]?hundred|雷速(?:体育)?|纳米数据|竞彩官方(?:数据)?源|竞彩网(?:官方)?(?:数据)?源?)/gi, neutral)
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::\d+)?(?:\/[^\s<>"'，。；、（）【】\])]+)?/gi, neutral)
    .replace(/\b(?:api[-_ ]?football|football[-_]data|leisu|nami|sofascore|flashscore|open[-_ ]?meteo|visualcrossing|wikidata)\b/gi, neutral)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/[^\s<>"'，。；、（）【】\])]+)?/g, neutral)
    .replace(/[a-z]:[\\/][^\s<>"'，。；、（）【】\])]+/gi, neutral)
    .replace(/(?:\.{0,2}\/|\\)[a-z_][\w.-]*(?:[\\/][\w.%:@?&=+~-]+)+/gi, neutral)
    .replace(/\b(?:data|server|scripts|outputs|cache|profiles|collectors)\/[\w./%:@?&=+~-]+/gi, neutral)
    .replace(/\b(?:sourceUrl|source_url|sourcePath|source_path)\s*[:=]\s*/gi, language === 'zh' ? '资料：' : 'Data: ');
}

export const sourceNeutralText = formatSourceNeutralText;

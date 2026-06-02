const https = require('https');
const iconv = require('iconv-lite');

https.get('https://odds.500.com/fenxi/ouzhi-1393328.shtml', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://odds.500.com/'
  }
}, (res) => {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    const html = iconv.decode(Buffer.concat(chunks), 'gb2312');
    
    // 提取函数
    function extractCompanyOdds(cid) {
      console.log(`\n--- 提取公司 cid=${cid} ---`);
      
      // 找到 id="cid" 的起始位置
      const searchStr = `id="${cid}"`;
      const idx = html.indexOf(searchStr);
      if (idx === -1) {
        console.log(`未找到 id="${cid}"`);
        return null;
      }
      
      // 截取之后 1500 个字符，这足够容纳赔率 table
      const subHtml = html.substring(idx, idx + 1500);
      
      // 提取 subHtml 中所有 td 内的数值
      // 我们只关注带有 onclick="OZ.r(this)" 属性的 td，且内容为浮点数
      const tdRegex = /<td[^>]*onclick="OZ\.r\(this\)"[^>]*>\s*([0-9.]+)\s*<\/td>/g;
      const odds = [];
      let tdMatch;
      while ((tdMatch = tdRegex.exec(subHtml)) !== null) {
        odds.push(parseFloat(tdMatch[1]));
      }
      
      console.log('匹配到的所有赔率数值:', odds);
      if (odds.length >= 6) {
        return {
          initial: { odds1: odds[0], oddsX: odds[1], odds2: odds[2] },
          current: { odds1: odds[3], oddsX: odds[4], odds2: odds[5] }
        };
      } else if (odds.length >= 3) {
        return {
          initial: { odds1: odds[0], oddsX: odds[1], odds2: odds[2] },
          current: null
        };
      }
      return null;
    }
    
    // 测试不同的公司ID
    // 3: Bet365, 4: Interwetten, 293: 威廉希尔, 280: 皇冠
    [3, 4, 293, 280].forEach(cid => {
      const res = extractCompanyOdds(cid);
      console.log('结果:', JSON.stringify(res, null, 2));
    });
  });
}).on('error', e => console.error('错误:', e.message));

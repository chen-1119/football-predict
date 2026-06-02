const http = require('http');
const https = require('https');
const urlModule = require('url');
const iconv = require('iconv-lite');

function httpGetBinary(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = urlModule.parse(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': 'http://odds.500.com/'
    };

    client.get(url, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        let redirectUrl = res.headers.location;
        if (redirectUrl && !redirectUrl.startsWith('http')) {
          redirectUrl = parsedUrl.protocol + '//' + parsedUrl.host + redirectUrl;
        }
        resolve(httpGetBinary(redirectUrl));
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, buffer });
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function run() {
  // 抓取昨天的页面
  const yesterday = '2026-06-01';
  const url = `https://odds.500.com/index_jczq_${yesterday}.shtml`;
  try {
    console.log(`Fetching yesterday's page: ${url}`);
    const { buffer } = await httpGetBinary(url);
    const html = iconv.decode(buffer, 'gb2312');
    console.log('HTML Length:', html.length);
    
    // 提取几行 data-cid="3" 的 TR
    const trMatches = [];
    const trRegex = /<tr[^>]*data-cid="3"[^>]*>([\s\S]*?)<\/tr>/g;
    let match;
    let count = 0;
    while ((match = trRegex.exec(html)) !== null && count < 3) {
      trMatches.push(match[0]);
      count++;
    }
    
    console.log(`Found ${trMatches.length} match rows from yesterday:`);
    trMatches.forEach((tr, i) => {
      console.log(`--- Match ${i + 1} ---`);
      console.log(tr.substring(0, 1000).replace(/\s+/g, ' '));
    });

  } catch (e) {
    console.error(e);
  }
}

run();

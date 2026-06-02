const https = require('https');
const http = require('http');
const iconv = require('iconv-lite');

function httpGetBinary(url) {
  return new Promise((resolve, reject) => {
    http.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    }).on('error', reject);
  });
}

async function run() {
  try {
    const buffer = await httpGetBinary('http://odds.500.com/index_jczq.shtml');
    const html = iconv.decode(buffer, 'gb2312');
    
    console.log('HTML Length:', html.length);
    
    // 找出前10个 <tr 标签的开头部分
    const trRegex = /<tr([^>]{1,300})/g;
    let match;
    let count = 0;
    console.log('--- Detected TR tags ---');
    while ((match = trRegex.exec(html)) !== null && count < 20) {
      console.log(`${count + 1}: <tr${match[1]}>`);
      count++;
    }
    
    // 如果有 matches，简单匹配一下我们原先的 regex
    const myRegex = /<tr[^>]*data-fid="(\d+)"[^>]*data-cid="3"[^>]*date-dtime="([^"]+)"[^>]*>/g;
    let myCount = 0;
    while ((match = myRegex.exec(html)) !== null && myCount < 10) {
      console.log(`Matched fid: ${match[1]}, dtime: ${match[2]}`);
      myCount++;
    }
    console.log(`Total matched by old regex: ${myCount}`);
  } catch (e) {
    console.error(e);
  }
}

run();

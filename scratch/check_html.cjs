const https = require('https');
https.get('https://chen-1119.github.io/football-predict/index.html', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('HTML Length:', data.length);
    console.log('HTML:', data);
  });
}).on('error', console.error);

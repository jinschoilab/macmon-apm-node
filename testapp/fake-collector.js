'use strict';
/**
 * macmon-server :6600 수집 포트를 흉내내는 로컬 테스트용 서버.
 * 실제 macmon-server 없이도 wire format이 올바른지 확인하기 위한 용도.
 */
const http = require('http');

const port = process.env.PORT || 6600;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { raw: body };
    }
    console.log(`\n=== ${req.method} ${req.url} ===`);
    console.log(JSON.stringify(parsed, null, 2));
    res.statusCode = 204;
    res.end();
  });
});

server.listen(port, () => {
  console.log(`fake collector listening on :${port}`);
});

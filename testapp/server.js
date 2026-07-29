'use strict';
/**
 * macmon-apm-node 스모크 테스트용 순수 Node http 서버.
 * 실행: node testapp/fake-collector.js 를 먼저 띄운 뒤 별도 터미널에서
 *       MACMON_APM_URL=http://127.0.0.1:6600 node testapp/server.js
 * curl http://localhost:3100/hello, /slow, /error, /outbound 로 확인.
 */
process.env.MACMON_APM_SERVICE = process.env.MACMON_APM_SERVICE || 'testapp';

const { start, stats } = require('../src/index');
start();

const http = require('http');

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    // 프레임워크(Express/Next.js)라면 이 지점에서 500을 응답해줌. 이 데모는
    // 프레임워크가 없으므로 흉내만 낸다 — macmon-apm-node의 예외 캡처 자체는
    // http.js의 emit 패치가 이 catch보다 먼저(더 바깥에서) 이미 처리했다.
    res.statusCode = 500;
    res.end(`error: ${e.message}`);
  }
});

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/hello') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/slow') {
    setTimeout(() => {
      res.end('slow done');
    }, 300);
    return;
  }

  if (url.pathname === '/error') {
    throw new Error('boom');
  }

  if (url.pathname === '/outbound') {
    fetch('http://127.0.0.1:3100/hello?token=secret')
      .then((r) => r.json())
      .then((data) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ upstream: data }));
      })
      .catch((e) => {
        res.statusCode = 502;
        res.end(String(e));
      });
    return;
  }

  if (url.pathname === '/stats') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(stats()));
    return;
  }

  res.statusCode = 404;
  res.end('not found');
}

const PORT = 3100;
server.listen(PORT, () => {
  console.log(`testapp listening on :${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('uncaught (expected for /error demo):', err.message);
});

'use strict';
/**
 * http/https/fetch 자동 계측.
 *
 * Inbound: http.Server/https.Server.prototype.emit을 패치해 'request' 이벤트를
 * 가로챈다. Next.js(`next start`)를 포함해 Node core http 위에서 도는 모든
 * 서버가 이 지점을 통과하므로 프레임워크 종류와 무관하게 동작한다.
 *
 * Outbound: http.request/http.get/https.request/https.get + 전역 fetch(undici)를
 * 패치해 현재 활성 트레이스가 있을 때만 "outbound" 자식 스팬을 만든다. 활성
 * 트레이스가 없으면 (예: 백그라운드 job) 원본 그대로 통과시켜 오버헤드가 없다.
 *
 * 분산 트레이싱(W3C traceparent): macmon RUM이 이미 same-origin 요청에
 * traceparent 헤더를 주입하므로(project_rum 참조), 인바운드에서 이를 파싱해
 * parent_trace_id로 실어보내면 RUM ↔ Node APM이 서버 변경 없이 연결된다.
 * 아웃바운드에도 자기 trace_id를 실어보내 하위 서비스까지 체인을 이어간다.
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Trace, TraceSpan, newTraceId } = require('./span');
const context = require('./context');

let inboundPatched = false;
let outboundPatched = false;

function genTraceId() {
  return crypto.randomBytes(16).toString('hex');
}
function genSpanId() {
  return crypto.randomBytes(8).toString('hex');
}

function safePath(rawUrl) {
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return rawUrl || '/';
  }
}

function redactUrl(fullUrl) {
  try {
    const u = new URL(fullUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return String(fullUrl).split('?')[0];
  }
}

function parseParentTraceId(traceparentHeader) {
  if (!traceparentHeader || typeof traceparentHeader !== 'string') return '';
  const parts = traceparentHeader.split('-');
  if (parts.length < 3) return '';
  const traceId = parts[1];
  if (!/^[0-9a-f]{32}$/i.test(traceId)) return '';
  return traceId;
}

function patchInboundServer(cfg, exporter) {
  if (inboundPatched) return;
  inboundPatched = true;

  for (const mod of [http, https]) {
    const origEmit = mod.Server.prototype.emit;
    mod.Server.prototype.emit = function (event, ...args) {
      if (event !== 'request') return origEmit.apply(this, [event, ...args]);
      const req = args[0];
      const res = args[1];
      return handleRequest(cfg, exporter, origEmit, this, req, res, args);
    };
  }
}

function handleRequest(cfg, exporter, origEmit, server, req, res, emitArgs) {
  const path = safePath(req.url);
  const traceId = genTraceId();
  const parentTraceId = parseParentTraceId(req.headers && req.headers['traceparent']);

  const trace = new Trace({ id: newTraceId(), host: cfg.host, service: cfg.service, comm: 'node' });
  trace.traceId = traceId;
  trace.parentTraceId = parentTraceId;

  const root = new TraceSpan({
    kind: 'server',
    httpMethod: req.method || '',
    httpPath: path,
  });
  trace.root = root;

  const store = { trace, currentSpan: root };

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    root.httpStatus = res.statusCode;
    trace.finish();
    exporter.submitTrace(trace.toJSON());
  };
  res.once('finish', finish);
  res.once('close', finish);

  return context.run(store, () => {
    try {
      return origEmit.apply(server, ['request', ...emitArgs]);
    } catch (e) {
      root.exceptionType = e && e.constructor ? e.constructor.name : 'Error';
      root.exceptionMsg = e && e.message ? String(e.message).slice(0, 500) : String(e);
      finish();
      throw e;
    }
  });
}

function extractMethodUrl(urlArg, optsArg, scheme) {
  let method = 'GET';
  let fullUrl = '';
  if (typeof urlArg === 'string' || urlArg instanceof URL) {
    fullUrl = urlArg.toString();
    const opts = optsArg && typeof optsArg === 'object' ? optsArg : {};
    method = (opts.method || 'GET').toUpperCase();
  } else if (urlArg && typeof urlArg === 'object') {
    const opts = urlArg;
    method = (opts.method || 'GET').toUpperCase();
    const host = opts.hostname || opts.host || 'localhost';
    const port = opts.port ? `:${opts.port}` : '';
    const pathPart = opts.path || '/';
    fullUrl = `${scheme}//${host}${port}${pathPart}`;
  }
  return { method, fullUrl };
}

function injectTraceparent(args, traceId) {
  // args: [url, options, callback] 또는 [options, callback] 형태. options에 headers를 병합.
  const spanId = genSpanId();
  const header = `00-${traceId}-${spanId}-01`;
  let optsIdx = -1;
  if (typeof args[0] === 'object' && !(args[0] instanceof URL) && args[0] !== null) {
    optsIdx = 0;
  } else if (args[1] && typeof args[1] === 'object') {
    optsIdx = 1;
  }
  if (optsIdx === -1) {
    // url만 있는 형태 — options 객체를 새로 끼워넣는다.
    const opts = { headers: { traceparent: header } };
    return [args[0], opts, ...args.slice(1)];
  }
  const opts = args[optsIdx];
  const headers = Object.assign({}, opts.headers, { traceparent: header });
  const newOpts = Object.assign({}, opts, { headers });
  const newArgs = args.slice();
  newArgs[optsIdx] = newOpts;
  return newArgs;
}

function wrapClientMethod(original, scheme) {
  return function (...args) {
    const store = context.getStore();
    if (!store || !store.currentSpan) {
      return original.apply(this, args);
    }
    const { method, fullUrl } = extractMethodUrl(args[0], args[1], scheme);
    const span = new TraceSpan({ kind: 'outbound', httpMethod: method, httpUrl: redactUrl(fullUrl) });
    const parent = store.currentSpan;

    const tracedArgs = injectTraceparent(args, store.trace.traceId || genTraceId());
    const req = original.apply(this, tracedArgs);

    let finished = false;
    const finish = (statusCode, err) => {
      if (finished) return;
      finished = true;
      if (err) {
        span.exceptionType = err.constructor ? err.constructor.name : 'Error';
        span.exceptionMsg = String(err.message || err).slice(0, 500);
      }
      span.httpStatus = statusCode || 0;
      span.finish();
      parent.children.push(span);
    };
    req.once('response', (res) => finish(res.statusCode));
    req.once('error', (err) => finish(0, err));
    return req;
  };
}

function patchOutboundHttp(cfg, exporter) {
  if (outboundPatched) return;
  outboundPatched = true;

  for (const [mod, scheme] of [
    [http, 'http:'],
    [https, 'https:'],
  ]) {
    const origRequest = mod.request;
    const origGet = mod.get;
    mod.request = wrapClientMethod(origRequest, scheme);
    mod.get = wrapClientMethod(origGet, scheme);
  }

  if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async function (input, init) {
      const store = context.getStore();
      if (!store || !store.currentSpan) {
        return origFetch(input, init);
      }
      const method = (init && init.method) || (input && input.method) || 'GET';
      const urlStr = typeof input === 'string' ? input : (input && input.url) || String(input);
      const span = new TraceSpan({
        kind: 'outbound',
        httpMethod: String(method).toUpperCase(),
        httpUrl: redactUrl(urlStr),
      });
      const parent = store.currentSpan;

      const spanId = genSpanId();
      const traceparent = `00-${store.trace.traceId || genTraceId()}-${spanId}-01`;
      const mergedInit = Object.assign({}, init, {
        headers: Object.assign({}, init && init.headers, { traceparent }),
      });

      try {
        const res = await origFetch(input, mergedInit);
        span.httpStatus = res.status;
        span.finish();
        parent.children.push(span);
        return res;
      } catch (e) {
        span.exceptionType = e && e.constructor ? e.constructor.name : 'Error';
        span.exceptionMsg = String(e && e.message ? e.message : e).slice(0, 500);
        span.finish();
        parent.children.push(span);
        throw e;
      }
    };
  }
}

module.exports = { patchInboundServer, patchOutboundHttp };

'use strict';
/**
 * Wire format. Java/Go/Python APM의 Trace/TraceSpan과 동일한 JSON 구조.
 * 서버 측 정의: macmon-server/internal/storage/traces.go의 Trace, TraceSpan.
 * 필드 이름은 서버 JSON 키와 정확히 일치해야 한다.
 *
 * start_ns/duration_ns는 process 시작 시점 기준 monotonic ns. JS Number는
 * 2^53까지만 정수를 정확히 표현하므로(약 104일), 프로세스가 그보다 오래
 * 떠 있으면 절대 start_ns 값의 정밀도가 떨어질 수 있다. duration_ns는
 * BigInt 뺄셈으로 계산 후 변환하므로(값 자체가 작음) 항상 정확하다.
 */
const { threadId } = require('worker_threads');

const _BOOT_NS = process.hrtime.bigint();

function nowNs() {
  return process.hrtime.bigint() - _BOOT_NS;
}

function wallNowISO() {
  // RFC3339. macmon-server는 Trace.wall_at을 Go time.Time(JSON은 RFC3339)로 파싱한다.
  return new Date().toISOString();
}

function toSafeNumber(bigintNs) {
  return Number(bigintNs);
}

class TraceSpan {
  constructor(opts) {
    opts = opts || {};
    this.kind = opts.kind; // server | db | outbound | exception
    this.tid = opts.tid != null ? opts.tid : threadId;
    this.startNs = opts.startNs != null ? opts.startNs : nowNs();
    this.durationNs = 0n;
    this.children = [];

    this.threadName = opts.threadName || '';
    this.httpMethod = opts.httpMethod || '';
    this.httpPath = opts.httpPath || '';
    this.httpStatus = opts.httpStatus || 0;
    this.httpUrl = opts.httpUrl || '';

    this.sql = opts.sql || '';
    this.rowCount = opts.rowCount || 0;

    this.clientIp = opts.clientIp || '';

    this.exceptionType = opts.exceptionType || '';
    this.exceptionMsg = opts.exceptionMsg || '';
  }

  finish() {
    this.durationNs = nowNs() - this.startNs;
  }

  toJSON() {
    const d = {
      kind: this.kind,
      tid: this.tid,
      start_ns: toSafeNumber(this.startNs),
      duration_ns: toSafeNumber(this.durationNs),
    };
    if (this.children.length) d.children = this.children.map((c) => c.toJSON());
    if (this.threadName) d.thread_name = this.threadName;
    if (this.httpMethod) d.http_method = this.httpMethod;
    if (this.httpPath) d.http_path = this.httpPath;
    if (this.httpStatus) d.http_status = this.httpStatus;
    if (this.httpUrl) d.http_url = this.httpUrl;
    if (this.clientIp) d.client_ip = this.clientIp;
    if (this.sql) d.sql = this.sql;
    if (this.rowCount) d.row_count = this.rowCount;
    if (this.exceptionType) d.exception_type = this.exceptionType;
    if (this.exceptionMsg) d.exception_msg = this.exceptionMsg;
    return d;
  }
}

class Trace {
  constructor(opts) {
    opts = opts || {};
    this.id = opts.id;
    this.host = opts.host;
    this.pid = opts.pid != null ? opts.pid : process.pid;
    this.comm = opts.comm || 'node';
    this.service = opts.service || '';
    this.wallAt = opts.wallAt || wallNowISO();
    this.startNs = opts.startNs != null ? opts.startNs : nowNs();
    this.durationNs = 0n;
    this.root = opts.root || null;
    this.traceId = opts.traceId || '';
    this.parentTraceId = opts.parentTraceId || '';
  }

  finish() {
    if (this.root) {
      this.root.finish();
      this.durationNs = this.root.durationNs;
    } else {
      this.durationNs = nowNs() - this.startNs;
    }
  }

  toJSON() {
    const d = {
      id: this.id,
      host: this.host,
      pid: this.pid,
      comm: this.comm,
      wall_at: this.wallAt,
      start_ns: toSafeNumber(this.startNs),
      duration_ns: toSafeNumber(this.durationNs),
      root_goid: 0, // 서버 호환용 더미. Node는 goroutine 개념 없음 (worker threadId는 span.tid로 실어보냄).
    };
    if (this.service) d.service = this.service;
    if (this.root) d.root = this.root.toJSON();
    if (this.traceId) d.trace_id = this.traceId;
    if (this.parentTraceId) d.parent_trace_id = this.parentTraceId;
    return d;
  }
}

function newTraceId() {
  return `tx_${threadId}_${process.hrtime.bigint().toString()}`;
}

module.exports = { Trace, TraceSpan, newTraceId, nowNs, wallNowISO };

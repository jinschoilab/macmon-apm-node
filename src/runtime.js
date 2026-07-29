'use strict';
/**
 * 런타임 샘플러. 서버 측 APMRuntimeSample 스키마(Go/Java 필드 혼재, 전부 omitempty)의
 * jvm_* 필드를 Python APM과 동일하게 재사용해 UI 그래프 변경 없이 묻어간다.
 * (server 측 node_* 전용 필드는 후속 단계에서 분리 예정 — macmon-apm-python의
 * Step 0→Step 1 전례와 동일한 패턴)
 *
 * - jvm_heap_used_kb : process.memoryUsage().heapUsed
 * - jvm_heap_max_kb  : v8.getHeapStatistics().heap_size_limit (V8 힙 상한)
 * - jvm_gc_count     : perf_hooks GC PerformanceObserver 누적 카운트
 *
 * jvm_thread_count 등 JVM 전용 개념과 대응이 애매한 필드는 허위 값을 보내지
 * 않기 위해 생략한다 (UI에 빈 값으로 표시되는 편이 낫다).
 */
const v8 = require('v8');
const { PerformanceObserver } = require('perf_hooks');

let gcCount = 0;
let gcObserver = null;

function ensureGcObserver() {
  if (gcObserver) return;
  try {
    gcObserver = new PerformanceObserver((list) => {
      gcCount += list.getEntries().length;
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch {
    // 일부 런타임/플래그 조합에서 gc entryType이 없을 수 있음 — 무해하게 무시
  }
}

function wallNowISO() {
  return new Date().toISOString();
}

function sample(cfg) {
  const mem = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  return {
    wall_at: wallNowISO(),
    host: cfg.host,
    service: cfg.service,
    lang: 'node',
    jvm_heap_used_kb: Math.round(mem.heapUsed / 1024),
    jvm_heap_max_kb: Math.round(heapStats.heap_size_limit / 1024),
    jvm_gc_count: gcCount,
  };
}

class RuntimeSampler {
  constructor(cfg, exporter) {
    this.cfg = cfg;
    this.exporter = exporter;
    this._timer = null;
    this._startTimer = null;
  }

  start() {
    if (this.cfg.disabled || this._timer || this._startTimer) return;
    ensureGcObserver();
    const intervalMs = Math.max(5, this.cfg.runtimeIntervalSec) * 1000;
    // 첫 샘플은 5초 지연 — 서비스명/환경 안정화 시간 확보 (Python과 동일)
    this._startTimer = setTimeout(() => {
      this._startTimer = null;
      this._tick();
      this._timer = setInterval(() => this._tick(), intervalMs);
      this._timer.unref();
    }, 5000);
    this._startTimer.unref();
  }

  _tick() {
    try {
      this.exporter.submitRuntime(sample(this.cfg));
    } catch {
      // 샘플러가 죽으면 안 됨
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._startTimer) clearTimeout(this._startTimer);
    this._timer = null;
    this._startTimer = null;
  }
}

module.exports = { RuntimeSampler };

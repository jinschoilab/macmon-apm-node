'use strict';
/**
 * HTTP exporter — 백그라운드 async pump 루프 + bounded queue.
 *
 * 설계 메모 (Python exporter.py와 동일한 원칙):
 * - 외부 의존성 없음. 전역 fetch(Node 18+)만 사용.
 * - 큐가 가득 차면 새 항목을 드롭 (앱을 막지 않는 게 우선).
 * - 실패한 요청은 재시도하지 않는다.
 * - Node는 데몬 스레드가 없으므로 'beforeExit'에서 잔여 큐를 짧게 flush한다
 *   (완벽하지 않음 — 강제 종료/크래시 시엔 유실될 수 있음).
 */

const MAX_QUEUE = 1024;
const POST_TIMEOUT_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Exporter {
  constructor(cfg) {
    this.cfg = cfg;
    this._queue = [];
    this._stopped = false;
    this._sent = 0;
    this._failed = 0;
    this._dropped = 0;

    if (cfg.disabled) return;

    this._pumpPromise = this._pump();
    this._exitHandler = () => this._onExit();
    process.on('beforeExit', this._exitHandler);
  }

  submitTrace(traceJson) {
    this._submit(this.cfg.traceEndpoint, traceJson);
  }

  submitRuntime(sampleJson) {
    this._submit(this.cfg.runtimeEndpoint, sampleJson);
  }

  _submit(endpoint, payload) {
    if (this.cfg.disabled) return;
    if (this._queue.length >= MAX_QUEUE) {
      this._dropped++;
      return;
    }
    this._queue.push({ endpoint, payload });
  }

  async _pump() {
    while (!this._stopped) {
      const item = this._queue.shift();
      if (!item) {
        await sleep(200);
        continue;
      }
      await this._post(item.endpoint, item.payload);
    }
  }

  async _post(endpoint, payload) {
    let body;
    try {
      body = JSON.stringify(payload);
    } catch {
      this._failed++;
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      this._sent++;
    } catch {
      this._failed++;
    } finally {
      clearTimeout(timer);
    }
  }

  async _onExit() {
    // beforeExit는 이벤트루프가 비기 직전에 뜨므로, 여기서 큐를 드레인하며
    // 새 마이크로태스크를 걸면 루프가 유지돼 실제로 flush가 끝날 때까지 기다려준다.
    const deadline = Date.now() + 1000;
    while (this._queue.length && Date.now() < deadline) {
      const item = this._queue.shift();
      await this._post(item.endpoint, item.payload);
    }
    this._stopped = true;
  }

  stats() {
    return { sent: this._sent, failed: this._failed, dropped: this._dropped, queued: this._queue.length };
  }
}

module.exports = { Exporter };

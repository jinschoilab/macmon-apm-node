'use strict';
/**
 * macmon Node.js APM (Step 0).
 *
 * 기본 사용 (Next.js instrumentation.ts):
 *   export async function register() {
 *     if (process.env.NEXT_RUNTIME === 'nodejs') {
 *       const { start } = await import('macmon-apm-node');
 *       start();
 *     }
 *   }
 *
 * 환경변수: MACMON_APM_URL / MACMON_APM_SERVICE / MACMON_APM_HOST / MACMON_APM_DISABLE
 * 서버: macmon-server(수집 포트 6600)의 POST /api/traces, POST /api/apm/runtime
 * 와이어 포맷: macmon-server/internal/storage/traces.go의 Trace/TraceSpan과 동일 (comm="node")
 */
const { Config } = require('./config');
const { Exporter } = require('./exporter');
const { RuntimeSampler } = require('./runtime');
const { patchInboundServer, patchOutboundHttp } = require('./http');
const { instrumentPrisma } = require('./prisma');

let agent = null;

function start(userConfig) {
  if (agent) return agent;

  const cfg = new Config(userConfig);
  if (cfg.disabled) {
    agent = { cfg, exporter: null, runtimeSampler: null };
    return agent;
  }

  const exporter = new Exporter(cfg);
  patchInboundServer(cfg, exporter);
  patchOutboundHttp(cfg, exporter);

  const runtimeSampler = new RuntimeSampler(cfg, exporter);
  runtimeSampler.start();

  agent = { cfg, exporter, runtimeSampler };
  return agent;
}

function stats() {
  if (!agent || !agent.exporter) return { started: false };
  return { started: true, ...agent.exporter.stats() };
}

module.exports = { start, stats, instrumentPrisma, Config };

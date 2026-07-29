'use strict';
/**
 * Next.js instrumentation.ts에서 그대로 re-export해 쓰기 위한 헬퍼.
 *
 * sarc의 instrumentation.ts:
 *   export async function register() {
 *     if (process.env.NEXT_RUNTIME === 'nodejs') {
 *       const { register } = await import('macmon-apm-node/instrumentation');
 *       await register();
 *     }
 *   }
 *
 * NEXT_RUNTIME 체크는 여기서도 한 번 더 하므로(Edge 런타임에서 http/crypto 등
 * Node 전용 모듈 require가 실패하는 걸 방지) 굳이 호출부에서 감싸지 않아도 안전하다.
 */
async function register() {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { start } = require('./index');
  start();
}

module.exports = { register };

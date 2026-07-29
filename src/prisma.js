'use strict';
/**
 * Prisma Client Extension으로 쿼리를 "db" 자식 스팬으로 캡처.
 *
 * 사용:
 *   const { PrismaClient } = require('@prisma/client')
 *   const { instrumentPrisma } = require('macmon-apm-node')
 *   const prisma = instrumentPrisma(new PrismaClient())
 *
 * $extends 기반 Client Extension API(Prisma 5.x 표준)를 사용한다. 구버전
 * $use 미들웨어(Prisma 4.x, deprecated)를 쓰는 프로젝트는 별도 어댑터 필요.
 *
 * 활성 트레이스(현재 서버 스팬)가 없으면 계측 오버헤드 없이 그대로 통과시킨다
 * (예: 앱 부팅 시점의 마이그레이션/시드 쿼리).
 */
const { TraceSpan, nowNs } = require('./span');
const context = require('./context');

function instrumentPrisma(prisma) {
  return prisma.$extends({
    name: 'macmon-apm',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const store = context.getStore();
          if (!store || !store.currentSpan) {
            return query(args);
          }

          const span = new TraceSpan({
            kind: 'db',
            sql: `${model || 'raw'}.${operation}`,
          });

          try {
            const result = await query(args);
            span.rowCount = Array.isArray(result) ? result.length : 1;
            return result;
          } catch (e) {
            span.exceptionType = e && e.constructor ? e.constructor.name : 'Error';
            span.exceptionMsg = String(e && e.message ? e.message : e).slice(0, 500);
            throw e;
          } finally {
            span.finish();
            store.currentSpan.children.push(span);
          }
        },
      },
    },
  });
}

module.exports = { instrumentPrisma };

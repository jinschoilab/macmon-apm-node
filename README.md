# macmon-apm-node

macmon용 Node.js APM 에이전트. Java/Go/Python APM과 동일한 wire format으로 `macmon-server`에 전송한다. 외부 의존성 0개 — Node 18+ 내장 기능(`fetch`, `AsyncLocalStorage`, `perf_hooks`, `worker_threads`)만 사용.

## 설치

아직 npm publish 전이므로 로컬 경로/git으로 의존:

```json
{
  "dependencies": {
    "macmon-apm-node": "file:../macmon-apm-node"
  }
}
```

## 사용 (Next.js 15)

`instrumentation.ts` (App Router, 프로젝트 루트 또는 `src/`):

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register } = await import("macmon-apm-node/instrumentation");
    await register();
  }
}
```

Prisma를 쓴다면 client 생성부에서 감싼다:

```ts
// lib/prisma.ts
import { PrismaClient } from "@prisma/client";
import { instrumentPrisma } from "macmon-apm-node";

export const prisma = instrumentPrisma(new PrismaClient());
```

## 사용 (일반 Node http 서버 / Express)

```js
require("macmon-apm-node").start(); // 가장 먼저, http 서버 생성 전에
const http = require("http");
// ...
```

## 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `MACMON_APM_URL` | `http://127.0.0.1:6600` | macmon-server 수집 포트 |
| `MACMON_APM_SERVICE` | `package.json`의 `name` | 서비스명 |
| `MACMON_APM_HOST` | `os.hostname()` | 호스트 식별자 |
| `MACMON_APM_DISABLE` | (미설정) | `"1"`이면 전송 전체 비활성 |
| `MACMON_APM_RUNTIME_INTERVAL_SEC` | `30` | 런타임(힙/GC) 샘플 주기, 최소 5초 |

## 잡히는 것 (Step 0)

- **Inbound**: `http`/`https` 서버로 들어오는 모든 요청 → `server` 스팬 (method/path/status). Next.js `next start`를 포함해 Node core http 위에서 도는 모든 서버에 프레임워크 무관하게 적용
- **Outbound**: `http.request`/`http.get`/`https.request`/`https.get` + 전역 `fetch` → `outbound` 자식 스팬. 현재 활성 트레이스가 있을 때만 생성 (백그라운드 호출은 오버헤드 없이 통과)
- **DB (Prisma)**: `instrumentPrisma()`로 감싼 클라이언트의 모든 쿼리 → `db` 자식 스팬 (`model.operation` + row_count)
- **분산 트레이싱**: 인바운드 `traceparent` 헤더(W3C)를 파싱해 `parent_trace_id`로 실어보내고, 아웃바운드 호출엔 자기 `trace_id`를 담은 `traceparent`를 주입. macmon RUM이 이미 same-origin 요청에 이 헤더를 붙이므로(`trace_enabled` 사이트) 서버 변경 없이 RUM ↔ Node APM 연결이 즉시 됨
- **런타임 샘플**: 30초 주기로 힙 사용량/최대 힙/GC 카운트 전송 (서버 스키마의 Java `jvm_*` 필드를 재사용 — UI 그래프가 바로 표시됨. Step 1에서 서버에 `node_*` 전용 필드 분리 예정)
- **예외**: request 핸들러 밖으로 완전히 빠져나온(uncaught) 예외만 `exception_type`/`exception_msg`로 캡처. Express/Next.js가 자체적으로 catch해서 500을 응답하는 경우는 `http_status`만 잡히고 예외 상세는 못 잡음 (프레임워크가 에러를 이미 삼켰기 때문 — Python WSGI 에이전트도 동일한 한계)

## 테스트

```bash
node testapp/fake-collector.js          # 터미널 1 — macmon-server 흉내
MACMON_APM_URL=http://127.0.0.1:6600 node testapp/server.js   # 터미널 2
curl localhost:3100/hello
curl localhost:3100/slow
curl localhost:3100/outbound   # 분산 트레이싱(parent_trace_id) 확인용
curl localhost:3100/error      # 예외 캡처 확인용
curl localhost:3100/stats      # exporter sent/failed/dropped 카운터
```

## 다음 단계 (Step 1)

- 서버 측 `APMRuntimeSample`에 `node_*` 전용 필드 추가 (현재 `jvm_*` 재사용은 임시)
- 이벤트 루프 지연(event loop lag) 샘플 추가
- Express/Fastify 등 프레임워크 레벨 에러 핸들러 훅 (진짜 exception 캡처)
- `mysql2`/`pg` 드라이버 직접 계측 (Prisma 미사용 프로젝트 대응)
- fork/cluster worker에서 `_BOOT_NS` 재계산 확인

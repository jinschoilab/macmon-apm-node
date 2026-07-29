# macmon-apm-node — Claude 컨텍스트

Node.js APM 에이전트. **Step 0 완료** — Java/Go/Python APM과 동일한 wire format으로 macmon-server에 전송. sarc.io(Next.js 15 + Prisma) 모니터링을 위해 시작됨.

## 핵심 사실

- 외부 의존성 0개. Node 18+ 내장(`fetch`/`AsyncLocalStorage`/`perf_hooks`/`worker_threads`/`crypto`)만 사용
- Wire format은 `macmon-server/internal/storage/traces.go`의 `Trace`/`TraceSpan`과 동일. `comm: "node"` — 서버의 `Trace.Lang()`에 node 분기 추가함(이 세션에서 패치, `internal/storage/traces.go:129` 근처)
- `AsyncLocalStorage` 기반 컨텍스트(`src/context.js`)로 요청 전체의 db/outbound 자식 스팬을 연결. 스레드 로컬이 없는 Node에서 WSGI의 `threading.get_ident()` 대체 역할
- 큐 드롭 모델(최대 1024) + 백그라운드 async pump. Node는 데몬 스레드가 없어 `process.on('beforeExit')`로 잔여 큐를 1초 한도로 flush (강제 kill/크래시 시엔 유실 가능 — Python의 atexit과 동일한 한계)
- **분산 트레이싱이 Step 0부터 이미 들어가 있음**: 인바운드 `traceparent` 파싱 → `parent_trace_id`, 아웃바운드에 자기 `trace_id` 주입. macmon RUM의 same-origin traceparent 주입과 서버 변경 없이 바로 연결됨(`[[project_rum]]` Phase 5 — 지금까지 Java APM만 되던 것에 Node APM도 추가됨, Go/Python은 여전히 인바운드 헤더 파싱 없음)

## 파일 가이드

- `src/index.js` — public API (`start`, `stats`, `instrumentPrisma`)
- `src/instrumentation.js` — Next.js `instrumentation.ts`에서 바로 쓰는 헬퍼(`register()`), `NEXT_RUNTIME` 체크 포함
- `src/config.js` — 환경변수 → Config. 서비스명 기본값은 가장 가까운 `package.json`의 `name` 탐색
- `src/span.js` — `Trace`/`TraceSpan` + `nowNs()`(`process.hrtime.bigint()` 기반, BOOT_NS 대비 상대값)
- `src/exporter.js` — bounded queue + async pump 루프 + `beforeExit` flush
- `src/context.js` — `AsyncLocalStorage` 래퍼 (`run`/`getStore`)
- `src/http.js` — inbound(`http`/`https` Server.emit 패치) + outbound(`request`/`get`/전역 `fetch` 패치) + traceparent 파싱/주입
- `src/prisma.js` — `instrumentPrisma()`, Prisma **Client Extension API**(`$extends`) 기반. 구버전 `$use` 미들웨어(Prisma 4.x)는 미지원
- `src/runtime.js` — 30초 주기. `jvm_heap_used_kb`/`jvm_heap_max_kb`/`jvm_gc_count`를 Java 필드명 그대로 재사용(서버 UI 호환, Python과 동일한 Step 0 편법)
- `testapp/` — 순수 Node http 데모(`server.js`) + macmon-server 흉내 로컬 수집기(`fake-collector.js`). 프레임워크 없이 raw http만 써서 계측 지점을 검증하는 용도

## 설계상 트레이드오프 (미래 세션에 중요)

- **`Number` 정밀도**: `start_ns`/`duration_ns`는 프로세스 부팅 이후 monotonic ns. JS `Number`는 2^53(~104일)까지만 정수 정확 — 그보다 오래 뜬 프로세스는 절대 `start_ns` 값의 정밀도가 떨어질 수 있음. `duration_ns`는 BigInt 뺄셈 후 변환이라 항상 정확(값 자체가 작음). Go/Java는 네이티브 64bit 정수라 이 문제가 없음 — Node만의 제약
- **예외 캡처는 반쪽**: `http.js`는 request 리스너 밖으로 완전히 새 나온(uncaught) 예외만 잡는다. Express/Next.js가 자체 에러 핸들러로 이미 삼킨 예외는 `http_status`만 보이고 `exception_type`/`exception_msg`는 비어있음 — 프레임워크 레벨 훅 없이는 원천적으로 안 보임(WSGI 에이전트도 Flask/Django가 자체적으로 삼키면 마찬가지)
- **outbound 계측은 활성 트레이스가 있을 때만** 스팬을 만든다 — 앱 부팅 시 초기화 호출이나 백그라운드 job의 HTTP 호출은 의도적으로 안 잡음(오버헤드 없음이 우선)
- **outbound URL은 쿼리스트링/프래그먼트를 제거하고 저장** — 토큰 등 민감정보 노출 방지. macmon RUM의 same-origin 제약과 같은 보안 원칙
- **`http.get`은 `http.request`와 별도로 패치해야 함** — Node 내부에서 `get`이 모듈 로컬 참조로 `request`를 호출하므로, `module.exports.request`만 덮어써도 `get` 경로는 원본을 그대로 씀. 이미 둘 다 패치되어 있음(`patchOutboundHttp`)
- **Prisma 계측은 `$extends` 가정** — 실제 sarc 코드가 구버전 `$use` 미들웨어를 쓰면 어댑터 추가 필요. sarc 코드 접근이 안 돼서(이 세션 진행 당시) 범용 가정으로 구현함

## 로컬 스모크테스트

README는 최종 사용자용이라 이 내용을 안 담았다. 개발 중 wire format/계측 지점 확인용:

```bash
node testapp/fake-collector.js          # 터미널 1 — macmon-server :6600 흉내, 받은 JSON을 그대로 출력
MACMON_APM_URL=http://127.0.0.1:6600 node testapp/server.js   # 터미널 2 — :3100
curl localhost:3100/hello
curl localhost:3100/slow       # 300ms 응답 — duration 측정 확인용
curl localhost:3100/outbound   # 자기 자신을 fetch로 호출 — outbound 스팬 + parent_trace_id 전파 확인용
curl localhost:3100/error      # uncaught 예외 — exception_type/msg 캡처 확인용
curl localhost:3100/stats      # exporter sent/failed/dropped/queued 카운터
```

## 다음 단계 (Step 1)

1. **서버 측 `node_*` 필드 분리** — `macmon-server/internal/storage/apm_runtime.go`의 `APMRuntimeSample`에 전용 필드 추가, UI 분기는 `lang="node"`로
2. **이벤트 루프 지연** — `perf_hooks.monitorEventLoopDelay()` 추가, Node 고유의 중요 신호(JVM에 없는 개념)
3. **프레임워크 에러 핸들러 훅** — Express `app.use((err, req, res, next) => ...)` / Next.js error boundary 연동으로 진짜 exception 캡처
4. **비-Prisma DB 드라이버** (`mysql2`, `pg`) 직접 계측
5. **sarc 실제 연동** — 코드 접근 가능해지면 App/Pages Router 여부, Prisma 버전, 프로덕션 실행 방식(`next start` vs custom server) 확인 후 위 가정들 검증

## 서버 측 변경 이력

- `macmon-server/internal/storage/traces.go`: `Trace.Lang()`에 `Comm == "node"` → `"node"` 분기 추가 (이전엔 `go`로 오분류됨). 다른 곳(`traces_query.go` 등)은 전부 `t.Lang() == lang` 문자열 비교라 추가 수정 불필요

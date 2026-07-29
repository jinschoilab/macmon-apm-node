# macmon-apm-node

**macmon**은 서버/DB/애플리케이션을 한 곳에서 모니터링하는 도구입니다. 이 패키지는 **Node.js로 만든 앱(Next.js, Express 등)**을 macmon 대시보드에서 볼 수 있게 해주는 에이전트예요.

설치하고 코드 두세 줄만 추가하면, 요청이 얼마나 걸렸는지, 어디서 에러가 났는지, DB 쿼리는 어땠는지가 macmon 대시보드에 자동으로 쌓입니다. 앱 코드를 거의 건드리지 않아도 됩니다.

## 준비물

- Node.js 18 이상
- macmon 서버 주소 (예: `http://내부서버IP:6600`) — 인프라 담당자에게 확인하세요

## 1. 설치

```bash
npm install github:jinschoilab/macmon-apm-node
```

## 2. 연결하기

### Next.js를 쓰는 경우 (권장 방법)

프로젝트 루트(또는 `src/`)에 `instrumentation.ts` 파일을 만드세요. 이미 있다면 안에 내용만 추가하면 됩니다.

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register } = await import("macmon-apm-node/instrumentation");
    await register();
  }
}
```

이게 전부입니다. Next.js가 서버를 시작할 때 자동으로 macmon 에이전트도 같이 켜집니다.

### Express / 일반 Node 서버를 쓰는 경우

서버를 시작하는 가장 첫 줄에 추가하세요 (http 서버 만들기 전에):

```js
require("macmon-apm-node").start();

const express = require("express");
// ... 이후는 원래 코드 그대로
```

### Prisma로 DB를 쓰는 경우 (선택)

DB 쿼리 속도까지 같이 보고 싶다면, Prisma 클라이언트를 만드는 곳에서 한 번만 감싸주세요.

```ts
// lib/prisma.ts
import { PrismaClient } from "@prisma/client";
import { instrumentPrisma } from "macmon-apm-node";

export const prisma = instrumentPrisma(new PrismaClient());
```

이후 앱 코드에서는 지금처럼 `prisma.user.findMany()` 등을 그대로 쓰면 됩니다. 이 부분을 생략해도 나머지 기능(요청 속도, 에러, 외부 API 호출)은 정상 동작합니다.

## 3. macmon 서버 주소 지정

환경변수 하나만 설정하면 됩니다. (`.env`, 배포 스크립트, systemd 설정 등 실행 환경에 맞게)

```bash
MACMON_APM_URL=http://내부서버IP:6600
```

이것만 설정하면 끝입니다. 나머지 옵션은 기본값으로 충분합니다.

## 4. 잘 붙었는지 확인하기

1. 위 설정을 하고 앱을 재시작하세요.
2. 앱에 요청을 몇 번 보내보세요 (페이지 새로고침 등).
3. macmon 대시보드의 **APM** 메뉴에서 방금 만든 서비스명이 보이면 성공입니다.

바로 안 보인다면 아래 "문제 해결"을 확인하세요.

## 자주 묻는 질문 / 문제 해결

**Q. 서비스 이름이 이상하게 나와요.**
기본값은 `package.json`의 `name`입니다. 원하는 이름으로 바꾸고 싶으면 환경변수를 추가하세요: `MACMON_APM_SERVICE=my-service-name`

**Q. 대시보드에 아무것도 안 보여요.**
- 앱 서버에서 macmon 서버(`MACMON_APM_URL`에 적은 주소)로 네트워크가 열려있는지 확인하세요 (방화벽/보안그룹).
- `instrumentation.ts`를 만들었다면 Next.js를 **재시작**했는지 확인하세요 (핫리로드로는 안 붙습니다).
- Express/일반 서버는 `require("macmon-apm-node").start()`가 서버 생성 **이전에**, 그리고 앱 진입점 파일 **가장 위쪽**에 있는지 확인하세요.

**Q. 이 에이전트가 앱 성능에 영향을 주나요?**
거의 없습니다. 데이터 전송은 별도로 처리되고, 전송 큐가 가득 차면 새 데이터를 버릴지언정 앱 응답을 절대 지연시키지 않습니다. macmon 서버에 연결이 안 돼도 앱은 정상 동작합니다 (에이전트만 조용히 재시도 없이 넘어갑니다).

**Q. 이 패키지가 앱 밖으로 내보내는 정보가 궁금해요.**
요청 경로/메서드/상태코드/걸린 시간, 요청자 IP(`X-Forwarded-For` 우선), DB 쿼리 종류와 소요시간, 외부 API 호출 대상(URL의 쿼리스트링은 제거하고 도메인+경로만), 에러 메시지 정도입니다. 요청 body나 쿼리 파라미터 값 자체는 수집하지 않습니다.

---

에이전트 내부 구현(어떤 원리로 계측하는지, 알려진 한계 등)은 [CLAUDE.md](./CLAUDE.md)를 참고하세요.

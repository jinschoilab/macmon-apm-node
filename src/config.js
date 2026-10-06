'use strict';
/**
 * 환경변수 기반 설정. Java/Go/Python APM과 동일한 키 컨벤션:
 * - MACMON_APM_URL       : macmon-server 수집 포트 (기본 http://127.0.0.1:6600)
 * - MACMON_APM_KEY       : 테넌트/팀 API 키(mak_…). 기록이 그 테넌트로 격리된다.
 *                          없으면 macmon-agent.conf($MACMON_HOME → 엔트리포인트 옆 → ~/.macmon-agent.conf)의 api_key
 * - MACMON_HOME          : macmon-agent 설치 디렉토리. conf(api_key)와 .macmon-agent.id를 여기서 먼저 찾는다
 * - MACMON_APM_SERVICE   : 서비스명. 미지정 시 package.json name 또는 "node"
 * - MACMON_APM_HOST      : 호스트 식별자. 미지정 시 os.hostname()
 * - MACMON_APM_AGENT_ID  : agent_id. 미지정 시 macmon-agent(Go)와 동일한 방식으로
 *                          .macmon-agent.id 파일에서 읽거나 생성(파일 위치 공유 시 자동 통일)
 * - MACMON_APM_DISABLE   : "1"이면 모든 전송 비활성 (테스트용)
 * - MACMON_APM_RUNTIME_INTERVAL_SEC : 런타임 샘플 주기 (기본 30)
 * - MACMON_APM_SAMPLE_RATE : 0~100 정수, 헤드 샘플링 비율 (기본 100 = 전량).
 *                            Java APM(macmon.sample.rate)과 동일한 개념 — 100 미만이면
 *                            일부 요청은 Trace 객체 자체를 만들지 않고 그대로 통과시킨다.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function defaultService() {
  try {
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name) return pkg.name;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return 'node';
}

function defaultHost() {
  try {
    return os.hostname() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function agentIdCandidatePaths() {
  // macmon-agent(Go, cmd/agent/main.go의 loadOrCreateAgentID)와 동일한 탐색 순서:
  // 1) 엔트리포인트(실행 스크립트) 옆  2) $HOME (하위 호환)
  // 같은 호스트에서 실행되면 같은 후보 경로를 공유하게 되어 agent_id가 자연히 통일된다.
  const candidates = [];
  // MACMON_HOME: macmon-agent 설치 디렉토리 — conf와 agent_id를 한 곳에서 공유
  if (process.env.MACMON_HOME) candidates.push(path.join(process.env.MACMON_HOME, '.macmon-agent.id'));
  try {
    const entryDir =
      require.main && require.main.filename ? path.dirname(require.main.filename) : process.cwd();
    candidates.push(path.join(entryDir, '.macmon-agent.id'));
  } catch {
    // fall through
  }
  try {
    const home = os.homedir();
    if (home) candidates.push(path.join(home, '.macmon-agent.id'));
  } catch {
    // fall through
  }
  return candidates;
}

// macmon-agent.conf의 api_key/team.key — macmon-agent(Go)와 같은 파일·같은 탐색 순서
// ($MACMON_HOME → 엔트리포인트 옆 macmon-agent.conf → ~/.macmon-agent.conf). 못 읽으면 ''.
function confApiKey() {
  const paths = [];
  if (process.env.MACMON_HOME) paths.push(path.join(process.env.MACMON_HOME, 'macmon-agent.conf'));
  try {
    const entryDir =
      require.main && require.main.filename ? path.dirname(require.main.filename) : process.cwd();
    paths.push(path.join(entryDir, 'macmon-agent.conf'));
  } catch {
    // fall through
  }
  try {
    const home = os.homedir();
    if (home) paths.push(path.join(home, '.macmon-agent.conf'));
  } catch {
    // fall through
  }
  for (const p of paths) {
    try {
      for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
        const line = raw.trim();
        const i = line.indexOf('=');
        if (!line || line.startsWith('#') || i < 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if ((k === 'team.key' || k === 'api_key') && v) return v;
      }
    } catch {
      // 파일 없음/권한 없음 — 다음 후보
    }
  }
  return '';
}

function defaultAgentId() {
  const candidates = agentIdCandidatePaths();

  // 기존 파일 탐색 — 첫 번째로 발견한 값 사용
  for (const p of candidates) {
    try {
      const data = fs.readFileSync(p, 'utf8');
      const id = data.trim();
      if (id) return id;
    } catch {
      // 파일 없음/읽기 실패 — 다음 후보로
    }
  }

  // 새 ID 생성 — 첫 번째로 쓰기 성공하는 후보에 저장
  const id = crypto.randomUUID();
  for (const p of candidates) {
    try {
      fs.writeFileSync(p, id + '\n', { mode: 0o600 });
      return id;
    } catch {
      // 쓰기 실패 — 다음 후보로
    }
  }

  // 저장 전부 실패 — 메모리에만 유지 (앱을 막으면 안 됨)
  // eslint-disable-next-line no-console
  console.warn(`[macmon-apm] agent ID 저장 실패 — 메모리에만 유지: ${id}`);
  return id;
}

class Config {
  constructor(overrides) {
    overrides = overrides || {};
    this.url = overrides.url || process.env.MACMON_APM_URL || 'http://127.0.0.1:6600';
    // 테넌트/팀 API 키(mak_…). 서버가 이 키로 기록의 테넌트를 확정한다. 없으면 default 테넌트
    this.apiKey = overrides.apiKey || process.env.MACMON_APM_KEY || confApiKey();
    this.service = overrides.service || process.env.MACMON_APM_SERVICE || defaultService();
    this.host = overrides.host || process.env.MACMON_APM_HOST || defaultHost();
    this.agentId = overrides.agentId || process.env.MACMON_APM_AGENT_ID || defaultAgentId();
    this.disabled = overrides.disabled != null ? overrides.disabled : process.env.MACMON_APM_DISABLE === '1';
    this.runtimeIntervalSec = Number(
      overrides.runtimeIntervalSec || process.env.MACMON_APM_RUNTIME_INTERVAL_SEC || 30
    );
    const rawSampleRate = Number(
      overrides.sampleRate != null ? overrides.sampleRate : process.env.MACMON_APM_SAMPLE_RATE
    );
    this.sampleRate = Number.isFinite(rawSampleRate) ? Math.min(100, Math.max(0, rawSampleRate)) : 100;
  }

  get traceEndpoint() {
    return this.url.replace(/\/+$/, '') + '/api/traces';
  }

  get runtimeEndpoint() {
    return this.url.replace(/\/+$/, '') + '/api/apm/runtime';
  }
}

module.exports = { Config };

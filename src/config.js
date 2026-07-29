'use strict';
/**
 * 환경변수 기반 설정. Java/Go/Python APM과 동일한 키 컨벤션:
 * - MACMON_APM_URL       : macmon-server 수집 포트 (기본 http://127.0.0.1:6600)
 * - MACMON_APM_SERVICE   : 서비스명. 미지정 시 package.json name 또는 "node"
 * - MACMON_APM_HOST      : 호스트 식별자. 미지정 시 os.hostname()
 * - MACMON_APM_DISABLE   : "1"이면 모든 전송 비활성 (테스트용)
 * - MACMON_APM_RUNTIME_INTERVAL_SEC : 런타임 샘플 주기 (기본 30)
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

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

class Config {
  constructor(overrides) {
    overrides = overrides || {};
    this.url = overrides.url || process.env.MACMON_APM_URL || 'http://127.0.0.1:6600';
    this.service = overrides.service || process.env.MACMON_APM_SERVICE || defaultService();
    this.host = overrides.host || process.env.MACMON_APM_HOST || defaultHost();
    this.disabled = overrides.disabled != null ? overrides.disabled : process.env.MACMON_APM_DISABLE === '1';
    this.runtimeIntervalSec = Number(
      overrides.runtimeIntervalSec || process.env.MACMON_APM_RUNTIME_INTERVAL_SEC || 30
    );
  }

  get traceEndpoint() {
    return this.url.replace(/\/+$/, '') + '/api/traces';
  }

  get runtimeEndpoint() {
    return this.url.replace(/\/+$/, '') + '/api/apm/runtime';
  }
}

module.exports = { Config };

'use strict';
/**
 * AsyncLocalStorage 기반 현재 트레이스/스팬 컨텍스트.
 * Node의 async/await, Promise, timer 경계를 넘어 자동으로 전파되므로
 * WSGI의 스레드 로컬(threading.get_ident())과 동등한 역할을 한다.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function run(store, fn) {
  return als.run(store, fn);
}

function getStore() {
  return als.getStore();
}

module.exports = { run, getStore };

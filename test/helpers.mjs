// 单测共用的小工具：假请求 / 假响应 / 假工作区实体。
// 不放进 `test/*.test.mjs` 的命名空间，避免被 `node --test 'test/*.test.mjs'` 当用例收集。

import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

/** 默认路由地址。 */
export const DEFAULT_URL = '/session-reattach';

/**
 * 造一个最小可用的请求对象：`Readable` 满足 `on('data')/on('end')`，
 * 其余字段按 IncomingMessage 的形状补齐。
 * @param {object} [init] 覆盖项。
 * @returns {object} 假请求。
 */
export function fakeRequest(init = {}) {
  const body = init.body ?? '';
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body)]);
  stream.method = init.method ?? 'POST';
  stream.url = init.url ?? DEFAULT_URL;
  stream.headers = init.headers ?? { 'content-type': 'application/json' };
  stream.destroy = () => stream.push(null);
  return stream;
}

/**
 * 造一个最小可用的响应对象，记录状态码、响应头与响应体。
 * @returns {object} 假响应。
 */
export function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(code) {
      this.statusCode = code;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += String(chunk);
    },
  };
}

/**
 * 造一个记录调用顺序的假工作区实体。
 * @param {string} path 工作区 canonical 路径。
 * @param {object} [options] 注入失败。
 * @param {Array<string>} log 共享调用日志。
 * @returns {object} 假实体。
 */
export function fakeWorkspace(path, options = {}, log = []) {
  return {
    path,
    attachSession: async (sessionId) => {
      log.push(`attach:${path}:${sessionId}`);
      if (options.failAttach === true) throw new Error('attach boom');
    },
    detachSession: async (sessionId) => {
      log.push(`detach:${path}:${sessionId}`);
      if (options.failDetach === true) throw new Error('detach boom');
    },
  };
}

/**
 * 造一条可归位计划条目。
 * @param {object} [overrides] 覆盖项。
 * @returns {object} 计划条目。
 */
export function planEntry(overrides = {}) {
  return {
    sessionId: 'session-new',
    cwd: '/work/beta',
    canonicalPath: '/work/beta',
    workspaceId: 'w2',
    workspaceTitle: 'beta',
    workspacePath: '/work/beta',
    ...overrides,
  };
}

/** 假规范化：忠实复刻真实实现的四类失败分支，但不碰文件系统。 */
export const DEAD_PATHS = new Set(['/work/gone']);

/**
 * 与真实实现同判据的假规范化函数（同步）。
 * @param {unknown} cwd 会话 cwd。
 * @returns {{ok: true, path: string} | {ok: false, reason: string}} 归一结果。
 */
export function fakeCanonicalize(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, reason: 'no-cwd' };
  if (!cwd.startsWith('/')) return { ok: false, reason: 'not-absolute' };
  const trimmed = cwd.replace(/\/+$/u, '');
  if (DEAD_PATHS.has(trimmed)) return { ok: false, reason: 'unresolvable' };
  return { ok: true, path: trimmed };
}

/**
 * 造一份形状完整的计划，用于汇报与 HTTP 两层的分支测试。
 * @param {object} [overrides] 覆盖顶层字段。
 * @returns {object} 计划。
 */
export function planFixture(overrides = {}) {
  return {
    workspaces: [
      { workspaceId: 'w1', title: 'alpha', path: '/work/alpha' },
      { workspaceId: 'w2', title: 'beta', path: '/work/beta' },
    ],
    reattachable: [planEntry()],
    accounted: [],
    noWorkspace: [],
    invalid: [],
    skipped: { archived: [], live: [], subagent: [] },
    total: 1,
    ...overrides,
  };
}

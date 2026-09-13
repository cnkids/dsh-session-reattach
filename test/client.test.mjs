// 浏览器半边行为测试 + bundle 漂移检查。
//
// 两个目的：
//   1. 漂移：lib/client.js 必须等于「重新合成」的结果，忘记跑生成脚本会让测试失败；
//   2. 行为：用最小假 DOM 把 dragstart → dragover → drop 整条链路跑一遍，
//      确认落点判定、请求体与提示条都符合契约（真实浏览器行为由端到端验证补）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { ROUTE_PATH, STATE_PATH } from '../lib/client-core.js';
import { OUT_PATH, buildBundle } from '../scripts/build-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const SESSION = 'session-4f8a1c2e-7b3d-4e5f-8a9b-0c1d2e3f4a5b';
const SESSION_ROW_SELECTOR = '[role="treeitem"][aria-selected]';
const GROUP_ROW_SELECTOR = '[role="treeitem"][aria-expanded][draggable="true"]';

const STATE_PAYLOAD = {
  ok: true,
  workspaces: [{ workspaceId: 'w2', title: 'beta', path: '/work/beta' }],
  sessions: [{ sessionId: SESSION, workspaceId: 'w2', workspaceTitle: 'beta' }],
};

/** 造一个可充当会话行 / 分组行的极简元素。 */
function makeElement(options = {}) {
  const classes = new Set();
  const element = {
    textContent: options.text ?? '',
    children: [],
    parentElement: null,
    className: '',
    style: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    appendChild: (child) => {
      element.children.push(child);
      return child;
    },
    closest: (selector) => (selector === options.closestFor ? element : null),
    querySelector: () => null,
    getAttribute: () => null,
  };
  return element;
}

/** 造一个记录监听的假 document。 */
function makeDocument(groupRows) {
  const listeners = new Map();
  const head = makeElement();
  const body = makeElement();
  return {
    head,
    body,
    listeners,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    createElement: () => makeElement(),
    getElementById: () => null,
    querySelectorAll: (selector) => (selector === GROUP_ROW_SELECTOR ? groupRows : []),
  };
}

/** 造 JSON 响应。 */
function jsonResponse(payload, status = 200) {
  return { ok: status < 400, status, json: async () => payload };
}

/** 造一次拖拽事件。 */
function dragEvent(target, sessionId) {
  return {
    target,
    defaultPrevented: false,
    dataTransfer: { dropEffect: 'none', getData: () => sessionId },
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

/** 冲掉微任务，等异步状态刷新落地。 */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 在假 DOM 里装载 bundle 并跑完 apply()。
 * @param {object} options 覆盖项。
 * @returns {Promise<object>} 环境句柄。
 */
async function mount(options = {}) {
  const alphaGroup = makeElement({ text: 'alpha', closestFor: GROUP_ROW_SELECTOR });
  const betaGroup = makeElement({ text: 'beta', closestFor: GROUP_ROW_SELECTOR });
  const sessionRow = makeElement({ closestFor: SESSION_ROW_SELECTOR });
  const document = makeDocument([alphaGroup, betaGroup]);
  const calls = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { sandbox.registration = spec; } } },
    document,
    console,
    // 定时器由沙箱接管：本文件不验证提示条自动消失，也就不让 6 秒定时器拖住测试进程
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === STATE_PATH) return options.stateResponse ?? jsonResponse(options.statePayload ?? STATE_PAYLOAD);
      return options.postResponse ?? jsonResponse({ ok: true, applied: [{ status: 'attached', workspaceTitle: 'beta' }] });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(await readFile(OUT_PATH, 'utf8'), sandbox);
  const module = sandbox.registration.factory();
  module.apply();
  await flush();
  return { sandbox, document, module, calls, alphaGroup, betaGroup, sessionRow };
}

/** 取提示条节点。 */
function toastOf(document) {
  return document.body.children.find((child) => String(child.className).includes('dsr-reattach-toast'));
}

test('lib/client.js 与生成脚本一致（忘记重新生成会在这里失败）', async () => {
  const committed = await readFile(OUT_PATH, 'utf8');
  assert.equal(committed, await buildBundle());
});

test('命令行重新生成是幂等的（跑完 bundle 不变）', async () => {
  const before = await readFile(OUT_PATH, 'utf8');
  await execFileAsync('node', [path.join(ROOT, 'scripts', 'build-client.mjs')]);
  assert.equal(await readFile(OUT_PATH, 'utf8'), before);
});

test('bundle 以包名注册，并导出 apply', async () => {
  const env = await mount();
  assert.equal(env.sandbox.registration.id, 'dsh-session-reattach');
  assert.equal(typeof env.module.apply, 'function');
  assert.deepEqual([...env.document.listeners.keys()].sort(), ['dragend', 'dragover', 'dragstart', 'drop']);
});

test('拖拽会话行时高亮 cwd 匹配的那个分组', async () => {
  const env = await mount();
  env.document.listeners.get('dragstart')[0](dragEvent(env.sessionRow, SESSION));
  await flush();
  assert.equal(env.betaGroup.classList.contains('dsr-reattach-target'), true);
  assert.equal(env.alphaGroup.classList.contains('dsr-reattach-target'), false);
});

test('只有目标分组接受放置，其它分组显示禁止光标', async () => {
  const env = await mount();
  env.document.listeners.get('dragstart')[0](dragEvent(env.sessionRow, SESSION));
  await flush();

  const allowed = dragEvent(env.betaGroup, SESSION);
  env.document.listeners.get('dragover')[0](allowed);
  assert.equal(allowed.defaultPrevented, true);
  assert.equal(allowed.dataTransfer.dropEffect, 'move');

  const rejected = dragEvent(env.alphaGroup, SESSION);
  env.document.listeners.get('dragover')[0](rejected);
  assert.equal(rejected.defaultPrevented, false);
  assert.equal(rejected.dataTransfer.dropEffect, 'none');
});

test('放置到目标分组时按契约提交请求并提示成功', async () => {
  const env = await mount();
  const handlers = env.document.listeners;
  handlers.get('dragstart')[0](dragEvent(env.sessionRow, SESSION));
  await flush();
  const drop = dragEvent(env.betaGroup, SESSION);
  handlers.get('drop')[0](drop);
  await flush();

  assert.equal(drop.defaultPrevented, true);
  const post = env.calls.find((call) => call.url === ROUTE_PATH);
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(post.init.body), { sessionId: SESSION, workspaceId: 'w2', dryRun: false });

  const toast = toastOf(env.document);
  assert.match(String(toast.className), /dsr-reattach-ok/u);
  assert.match(toast.textContent, /已归位到「beta」/u);
});

test('放置到错误分组时既不提交请求也不阻止默认行为', async () => {
  const env = await mount();
  const handlers = env.document.listeners;
  handlers.get('dragstart')[0](dragEvent(env.sessionRow, SESSION));
  await flush();
  const drop = dragEvent(env.alphaGroup, SESSION);
  handlers.get('drop')[0](drop);
  await flush();
  assert.equal(drop.defaultPrevented, false);
  assert.equal(env.calls.filter((call) => call.url === ROUTE_PATH).length, 0);
  assert.equal(toastOf(env.document), undefined);
});

test('宿主返回拒绝结论时把原文显示为错误提示', async () => {
  const env = await mount({
    postResponse: jsonResponse({ ok: true, single: { status: 'rejected', code: 'cwd-invalid', message: '未归位：cwd 已失效（/old）。' } }),
  });
  const handlers = env.document.listeners;
  handlers.get('dragstart')[0](dragEvent(env.sessionRow, SESSION));
  await flush();
  handlers.get('drop')[0](dragEvent(env.betaGroup, SESSION));
  await flush();
  const toast = toastOf(env.document);
  assert.match(String(toast.className), /dsr-reattach-err/u);
  assert.equal(toast.textContent, '未归位：cwd 已失效（/old）。');
});

test('状态未知的会话放行落点，由宿主解释原因', async () => {
  const env = await mount({ statePayload: { ok: true, workspaces: [], sessions: [] } });
  const handlers = env.document.listeners;
  handlers.get('dragstart')[0](dragEvent(env.sessionRow, SESSION));
  await flush();
  const drop = dragEvent(env.alphaGroup, SESSION);
  handlers.get('drop')[0](drop);
  await flush();
  assert.equal(drop.defaultPrevented, true);
  const post = env.calls.find((call) => call.url === ROUTE_PATH);
  assert.deepEqual(JSON.parse(post.init.body), { sessionId: SESSION, dryRun: false });
});

test('认证被拒时给出可操作的提示而不是「无法识别」', async () => {
  const env = await mount({ postResponse: jsonResponse(undefined, 403) });
  const handlers = env.document.listeners;
  handlers.get('dragstart')[0](dragEvent(env.sessionRow, SESSION));
  await flush();
  handlers.get('drop')[0](dragEvent(env.betaGroup, SESSION));
  await flush();
  assert.match(toastOf(env.document).textContent, /未通过认证/u);
});

test('状态端点失败时仍不抛错，落点交给宿主判定', async () => {
  const env = await mount({ stateResponse: jsonResponse(undefined, 500) });
  const handlers = env.document.listeners;
  handlers.get('dragstart')[0](dragEvent(env.sessionRow, SESSION));
  await flush();
  const drop = dragEvent(env.betaGroup, SESSION);
  handlers.get('drop')[0](drop);
  await flush();
  assert.equal(drop.defaultPrevented, true);
});

test('拖拽目标不是会话行时整条链路保持静默', async () => {
  const env = await mount();
  const handlers = env.document.listeners;
  const foreign = makeElement();
  handlers.get('dragstart')[0](dragEvent(foreign, SESSION));
  await flush();
  const drop = dragEvent(env.betaGroup, SESSION);
  handlers.get('dragover')[0](drop);
  assert.equal(drop.defaultPrevented, false);
  assert.equal(env.calls.filter((call) => call.url === ROUTE_PATH).length, 0);
});

test('拖拽结束会清掉高亮', async () => {
  const env = await mount();
  const handlers = env.document.listeners;
  handlers.get('dragstart')[0](dragEvent(env.sessionRow, SESSION));
  await flush();
  assert.equal(env.betaGroup.classList.contains('dsr-reattach-target'), true);
  handlers.get('dragend')[0]({});
  assert.equal(env.betaGroup.classList.contains('dsr-reattach-target'), false);
});

test('bundle 不引入外部模块依赖（dsh.client.external 可以为空）', async () => {
  const source = await readFile(OUT_PATH, 'utf8');
  assert.doesNotMatch(source, /\brequire\s*\(/u);
  assert.doesNotMatch(source, /^\s*import\s/mu);
  assert.equal(path.relative(ROOT, OUT_PATH), path.join('lib', 'client.js'));
});

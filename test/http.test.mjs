// HTTP 路由测试：这是浏览器半边唯一的写入入口，守卫、方法与体积都必须失败关闭。

import test from 'node:test';
import assert from 'node:assert/strict';

import { ROUTE_PATH, STATE_PATH, createRouteHandler } from '../lib/http.js';
import { fakeRequest, fakeResponse, planEntry, planFixture } from './helpers.mjs';

/** 造一份可注入的依赖，记录 execute 的调用。 */
function makeDeps(options = {}) {
  const executed = [];
  let planCalls = 0;
  const deps = {
    reject: () => options.rejection,
    collectPlan: async () => {
      planCalls += 1;
      return planFixture(options.plan);
    },
    execute: async (plan) => {
      executed.push(plan);
      return [{ sessionId: 'session-new', status: 'attached', workspaceId: 'w2', workspaceTitle: 'beta' }];
    },
  };
  return { deps, executed, planCalls: () => planCalls };
}

/** 跑一次请求并取回响应。 */
async function run(deps, init) {
  const res = fakeResponse();
  await createRouteHandler(deps)(fakeRequest(init), res);
  return res;
}

/** 解析 JSON 响应体。 */
function json(res) {
  return JSON.parse(res.body);
}

test('守卫拒绝时直接终止，且不生成任何计划', async () => {
  const { deps, planCalls } = makeDeps({ rejection: 403 });
  const res = await run(deps, { body: '{}' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, 'forbidden');
  assert.equal(planCalls(), 0);
});

test('未认证时回 401 而不是 403', async () => {
  const { deps } = makeDeps({ rejection: 401 });
  const res = await run(deps, { body: '{}' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body, 'unauthorized');
});

test('状态端点回工作区与可归位会话的映射', async () => {
  const { deps } = makeDeps();
  const res = await run(deps, { method: 'GET', url: STATE_PATH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = json(res);
  assert.equal(body.workspaces.length, 2);
  assert.deepEqual(body.sessions, [{ sessionId: 'session-new', workspaceId: 'w2', workspaceTitle: 'beta' }]);
});

test('对动作端点用 GET 回 405 并声明允许的方法', async () => {
  const { deps } = makeDeps();
  const res = await run(deps, { method: 'GET', url: ROUTE_PATH });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST');
});

test('content-type 不是 JSON 时回 415', async () => {
  const { deps } = makeDeps();
  const res = await run(deps, { headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(res.statusCode, 415);
  assert.equal(json(res).code, 'unsupported-media-type');
});

test('请求体不是合法 JSON 时回 400', async () => {
  const { deps } = makeDeps();
  const res = await run(deps, { body: '{' });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).code, 'invalid-json');
});

test('请求体超限时回 413', async () => {
  const { deps } = makeDeps();
  const res = await run(deps, { body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) });
  assert.equal(res.statusCode, 413);
  assert.equal(json(res).code, 'payload-too-large');
});

test('默认是 dry-run：即使不带任何字段也不写入', async () => {
  const { deps, executed } = makeDeps();
  const res = await run(deps, { body: '{}' });
  const body = json(res);
  assert.equal(res.statusCode, 200);
  assert.equal(body.dryRun, true);
  assert.deepEqual(body.applied, []);
  assert.equal(executed.length, 0);
  assert.match(body.report, /dry-run/u);
  assert.equal(body.plan.counts.reattachable, 1);
});

test('空请求体按空对象处理', async () => {
  const { deps } = makeDeps();
  const res = await run(deps, { body: '' });
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).dryRun, true);
});

test('非对象 JSON（如字符串）按空对象处理，不写入', async () => {
  const { deps, executed } = makeDeps();
  const res = await run(deps, { body: '"nope"' });
  assert.equal(res.statusCode, 200);
  assert.equal(executed.length, 0);
});

test('只有显式 dryRun:false 才执行全量归位', async () => {
  const { deps, executed } = makeDeps();
  const res = await run(deps, { body: JSON.stringify({ dryRun: false }) });
  const body = json(res);
  assert.equal(executed.length, 1);
  assert.equal(body.dryRun, false);
  assert.deepEqual(body.summary, { attached: 1, failed: 0 });
  assert.match(body.report, /已执行/u);
});

test('单会话模式：落点正确且 apply 时只归位这一条', async () => {
  const { deps, executed } = makeDeps();
  const res = await run(deps, { body: JSON.stringify({ sessionId: 'session-new', workspaceId: 'w2', dryRun: false }) });
  const body = json(res);
  assert.equal(body.single.status, 'ready');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].reattachable.length, 1);
  assert.deepEqual(executed[0].reattachable[0].sessionId, 'session-new');
});

test('单会话模式：落点正确但不带 dryRun:false 时仍不写入', async () => {
  const { deps, executed } = makeDeps();
  const res = await run(deps, { body: JSON.stringify({ sessionId: 'session-new', workspaceId: 'w2' }) });
  assert.equal(json(res).single.status, 'ready');
  assert.equal(executed.length, 0);
});

test('单会话模式：落点错误时回 mismatch 且绝不写入', async () => {
  const { deps, executed } = makeDeps();
  const res = await run(deps, { body: JSON.stringify({ sessionId: 'session-new', workspaceId: 'w1', dryRun: false }) });
  const body = json(res);
  assert.equal(body.single.code, 'workspace-mismatch');
  assert.equal(body.single.status, 'rejected');
  assert.equal(executed.length, 0);
});

test('单会话模式：无匹配工作区时回 no-workspace', async () => {
  const { deps, executed } = makeDeps({
    plan: { total: 1, reattachable: [], noWorkspace: [{ sessionId: 'session-stray', cwd: '/work/nowhere', canonicalPath: '/work/nowhere' }] },
  });
  const res = await run(deps, { body: JSON.stringify({ sessionId: 'session-stray', dryRun: false }) });
  assert.equal(json(res).single.code, 'no-workspace');
  assert.equal(executed.length, 0);
});

test('单会话模式：sessionId 类型不合法时退回全量模式', async () => {
  const { deps } = makeDeps();
  const res = await run(deps, { body: JSON.stringify({ sessionId: 42 }) });
  const body = json(res);
  assert.equal(body.single, undefined);
  assert.equal(body.plan.counts.reattachable, 1);
});

test('未知端点回 404', async () => {
  const { deps } = makeDeps();
  const res = await run(deps, { url: `${ROUTE_PATH}/nope` });
  assert.equal(res.statusCode, 404);
  assert.equal(json(res).code, 'not-found');
});

test('请求地址无法解析时按未知端点处理，而不是抛错', async () => {
  const { deps } = makeDeps();
  const res = await run(deps, { url: 'http://' });
  assert.equal(res.statusCode, 404);
  assert.equal(json(res).code, 'not-found');
});

test('请求体读取失败时回 400', async () => {
  const { deps } = makeDeps();
  const req = {
    method: 'POST',
    url: ROUTE_PATH,
    headers: { 'content-type': 'application/json' },
    on(event, handler) {
      if (event === 'error') queueMicrotask(() => handler(new Error('socket boom')));
      return req;
    },
    destroy() {},
  };
  const res = fakeResponse();
  await createRouteHandler(deps)(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).code, 'body-read-failed');
});

test('计划投影截断超长列表但保留计数', async () => {
  const many = Array.from({ length: 250 }, (_unused, index) => planEntry({ sessionId: `session-${index}` }));
  const { deps } = makeDeps({ plan: { total: 250, reattachable: many } });
  const res = await run(deps, { body: '{}' });
  const body = json(res);
  assert.equal(body.plan.reattachable.length, 200);
  assert.equal(body.plan.counts.reattachable, 250);
});

test('计划投影带回截断条数（宿主侧窗口上限）', async () => {
  const { deps } = makeDeps({ plan: { total: 10, reattachable: [], truncated: 42 } });
  const res = await run(deps, { body: '{}' });
  assert.equal(json(res).plan.truncated, 42);
});

test('状态端点也回截断条数，便于前端如实提示', async () => {
  const { deps } = makeDeps({ plan: { total: 10, reattachable: [], truncated: 42 } });
  const res = await run(deps, { method: 'GET', url: STATE_PATH });
  assert.equal(json(res).truncated, 42);
});

test('信任判定抛错 → JSON 500 与故障上报，且不写入', async () => {
  const faults = [];
  const executed = [];
  const deps = {
    reject: () => {
      throw new Error('connection unavailable');
    },
    collectPlan: async () => planFixture(),
    execute: async (plan) => {
      executed.push(plan);
      return [];
    },
    reportFault: (error) => faults.push(error.message),
  };
  const res = await run(deps, { body: JSON.stringify({ dryRun: false }) });
  assert.equal(res.statusCode, 500);
  assert.equal(json(res).code, 'internal-error');
  assert.deepEqual(faults, ['connection unavailable']);
  assert.deepEqual(executed, []);
  assert.doesNotMatch(res.body, /connection unavailable/u, '内部细节不得回给调用方');
});

test('计划装配抛错 → JSON 500，且不写入', async () => {
  const executed = [];
  const deps = {
    reject: () => undefined,
    collectPlan: async () => {
      throw new Error('SESSION_QUERY_PERSISTENCE_FAILED');
    },
    execute: async (plan) => {
      executed.push(plan);
      return [];
    },
  };
  const res = await run(deps, { body: JSON.stringify({ dryRun: false }) });
  assert.equal(res.statusCode, 500);
  assert.equal(json(res).code, 'internal-error');
  assert.deepEqual(executed, []);
});

test('执行阶段抛错 → JSON 500，且不把异常抛给 webServer', async () => {
  const deps = {
    reject: () => undefined,
    collectPlan: async () => planFixture(),
    execute: async () => {
      throw new Error('execute boom');
    },
  };
  const res = await run(deps, { body: JSON.stringify({ dryRun: false }) });
  assert.equal(res.statusCode, 500);
  assert.equal(json(res).code, 'internal-error');
});

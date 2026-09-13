// 宿主入口集成测试：用假 ctx 把 index → host → plan → execute → http 整条链路跑通，
// 确认与 DSH 服务之间的契约（inject 名、路由形状、命令名、写入顺序）没有偏差。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply, inject, name } from '../lib/index.js';
import { ROUTE_PATH, STATE_PATH } from '../lib/http.js';
import { fakeRequest, fakeResponse } from './helpers.mjs';

// 用真实临时目录：这条链路会走真实的 fs.realpath 校验，假路径会被（正确地）判成 cwd 失效。
const ROOT = await realpath(await mkdtemp(path.join(tmpdir(), 'reattach-int-')));
const WORK_PATH = path.join(ROOT, 'alpha');
const OTHER_PATH = path.join(ROOT, 'beta');
await mkdir(WORK_PATH);
await mkdir(OTHER_PATH);

/** 造一个假工作区实体，记录 attach / detach 调用。 */
function fakeEntity(id, title, path, sessionIds, log) {
  return {
    id,
    title,
    path,
    sessionIds,
    attachSession: async (sessionId) => log.push(`attach:${path}:${sessionId}`),
    detachSession: async (sessionId) => log.push(`detach:${path}:${sessionId}`),
  };
}

/** 造一个假 ctx，覆盖本插件用到的那几个服务。 */
function fakeCtx(options = {}) {
  const log = [];
  const registered = { routes: [], commands: [], effects: [] };
  const workspaces = options.workspaces ?? [
    fakeEntity('w1', 'alpha', WORK_PATH, options.accounted ?? [], log),
    fakeEntity('w2', 'beta', OTHER_PATH, [], log),
  ];
  const ctx = {
    connection: { requestRejection: () => options.rejection },
    webServer: {
      register: (route) => {
        registered.routes.push(route);
        return () => registered.routes.pop();
      },
    },
    commands: {
      register: (command) => {
        registered.commands.push(command);
        return () => registered.commands.pop();
      },
    },
    workspaceRegistry: {
      list: () => workspaces,
      get: (workspaceId) => workspaces.find((workspace) => String(workspace.id) === String(workspaceId)),
      archivedSessionIds: options.archivedSessionIds ?? [],
    },
    sessionQuery: { listSessions: async () => options.records ?? [] },
    get: (key) => (key === 'sessions' ? options.sessions : undefined),
    effect: (setup, label) => {
      registered.effects.push({ label, dispose: setup() });
    },
  };
  return { ctx, registered, log };
}

/** 跑一次已注册路由。 */
async function callRoute(registered, init) {
  const [route] = registered.routes;
  const res = fakeResponse();
  await route.handler(fakeRequest(init), res);
  return res;
}

test('插件身份与依赖服务齐备', () => {
  assert.equal(name, 'session-reattach');
  assert.deepEqual(inject, ['workspaceRegistry', 'sessionQuery', 'webServer', 'commands', 'connection']);
});

test('apply 注册一条前缀路由与一个命令，并登记可回收的 effect', () => {
  const { ctx, registered } = fakeCtx();
  apply(ctx);
  assert.equal(registered.routes.length, 1);
  assert.equal(registered.routes[0].kind, 'prefix');
  assert.equal(registered.routes[0].path, ROUTE_PATH);
  assert.equal(registered.commands.length, 1);
  assert.equal(registered.commands[0].name, 'reattach');
  assert.equal(registered.effects.length, 2);
  for (const effect of registered.effects) assert.equal(typeof effect.dispose, 'function');
});

test('守卫拒绝时路由不进入业务逻辑', async () => {
  const { ctx, registered, log } = fakeCtx({ rejection: 403 });
  apply(ctx);
  const res = await callRoute(registered, { body: JSON.stringify({ dryRun: false }) });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(log, []);
});

test('真实链路：dry-run 不写入，apply 先清其它工作区再归位目标', async () => {
  const records = [
    { header: { id: 'session-orphan', cwd: WORK_PATH, delegationDepth: 0 } },
    { header: { id: 'session-kept', cwd: WORK_PATH, delegationDepth: 0 } },
  ];
  const { ctx, registered, log } = fakeCtx({ records, accounted: ['session-kept'] });
  apply(ctx);

  const dry = await callRoute(registered, { body: '{}' });
  const dryBody = JSON.parse(dry.body);
  assert.equal(dryBody.dryRun, true);
  assert.equal(dryBody.plan.counts.reattachable, 1);
  assert.equal(dryBody.plan.counts.accounted, 1);
  assert.deepEqual(log, [], 'dry-run 阶段绝不能写');

  const applied = await callRoute(registered, { body: JSON.stringify({ dryRun: false }) });
  const appliedBody = JSON.parse(applied.body);
  assert.deepEqual(appliedBody.summary, { attached: 1, failed: 0 });
  assert.deepEqual(log, [`detach:${OTHER_PATH}:session-orphan`, `attach:${WORK_PATH}:session-orphan`]);
});

test('真实链路：状态端点只暴露可归位会话的落点映射', async () => {
  const records = [
    { header: { id: 'session-orphan', cwd: WORK_PATH, delegationDepth: 0 } },
    { header: { id: 'session-stray', cwd: '/work/nowhere', delegationDepth: 0 } },
    { header: { id: 'session-kept', cwd: WORK_PATH, delegationDepth: 0 } },
  ];
  const { ctx, registered } = fakeCtx({ records, accounted: ['session-kept'] });
  apply(ctx);
  const res = await callRoute(registered, { method: 'GET', url: STATE_PATH });
  const body = JSON.parse(res.body);
  assert.deepEqual(body.sessions, [{ sessionId: 'session-orphan', workspaceId: 'w1', workspaceTitle: 'alpha' }]);
  assert.deepEqual(body.workspaces.map((workspace) => workspace.workspaceId), ['w1', 'w2']);
});

test('真实链路：活跃会话与子代理会话按策略跳过', async () => {
  const records = [
    { header: { id: 'session-running', cwd: WORK_PATH, delegationDepth: 0 } },
    { header: { id: 'session-child', cwd: WORK_PATH, delegationDepth: 1 } },
  ];
  const { ctx, registered } = fakeCtx({ records, sessions: { list: () => [{ header: { id: 'session-running' } }] } });
  apply(ctx);
  const res = await callRoute(registered, { body: '{}' });
  const body = JSON.parse(res.body);
  assert.equal(body.plan.counts.reattachable, 0);
  assert.equal(body.plan.counts.live, 1);
  assert.equal(body.plan.counts.subagent, 1);
});

test('真实链路：已归档会话即使 cwd 匹配也不动', async () => {
  const records = [{ header: { id: 'session-archived', cwd: WORK_PATH, delegationDepth: 0 } }];
  const { ctx, registered, log } = fakeCtx({ records, archivedSessionIds: ['session-archived'] });
  apply(ctx);
  const res = await callRoute(registered, { body: JSON.stringify({ dryRun: false }) });
  assert.equal(JSON.parse(res.body).plan.counts.archived, 1);
  assert.deepEqual(log, []);
});

test('真实链路：拖错分组时回 mismatch 且不写入', async () => {
  const records = [{ header: { id: 'session-orphan', cwd: WORK_PATH, delegationDepth: 0 } }];
  const { ctx, registered, log } = fakeCtx({ records });
  apply(ctx);
  const res = await callRoute(registered, { body: JSON.stringify({ sessionId: 'session-orphan', workspaceId: 'w2', dryRun: false }) });
  const body = JSON.parse(res.body);
  assert.equal(body.single.code, 'workspace-mismatch');
  assert.equal(body.single.status, 'rejected');
  assert.deepEqual(log, []);
});

test('命令入口复用同一套依赖：dry-run 报告与执行', async () => {
  const records = [{ header: { id: 'session-orphan', cwd: WORK_PATH, delegationDepth: 0 } }];
  const { ctx, registered, log } = fakeCtx({ records });
  apply(ctx);
  const [command] = registered.commands;
  const dry = await command.handler({ rawInput: '' });
  assert.match(dry.text, /dry-run/u);
  assert.deepEqual(log, []);
  const applied = await command.handler({ rawInput: 'apply' });
  assert.match(applied.text, /已执行/u);
  assert.deepEqual(log, [`detach:${OTHER_PATH}:session-orphan`, `attach:${WORK_PATH}:session-orphan`]);
});

test('工作区消失时 attach 无从下手，但报告仍然产出', async () => {
  const records = [{ header: { id: 'session-orphan', cwd: WORK_PATH, delegationDepth: 0 } }];
  const { ctx, registered } = fakeCtx({ records });
  apply(ctx);
  // 计划生成后工作区被删：resolve 返回 undefined
  ctx.workspaceRegistry.get = () => undefined;
  const res = await callRoute(registered, { body: JSON.stringify({ dryRun: false }) });
  const body = JSON.parse(res.body);
  assert.equal(body.summary.failed, 1);
  assert.equal(body.applied[0].code, 'workspace-not-found');
});

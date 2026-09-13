// 归位计划测试：五种分类必须互斥且完备，且计划本身是 JSON 安全的
// （它会直接回给浏览器半边，带实体对象会在序列化时炸掉）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPlan, pickSession } from '../lib/core/plan.js';
import { fakeCanonicalize } from './helpers.mjs';

const WORKSPACES = [
  { workspaceId: 'w1', title: 'alpha', path: '/work/alpha', sessionIds: ['session-a'] },
  { workspaceId: 'w2', title: 'beta', path: '/work/beta', sessionIds: [] },
];

const SESSIONS = [
  { sessionId: 'session-new', cwd: '/work/beta/', delegationDepth: 0 },
  { sessionId: 'session-a', cwd: '/work/alpha', delegationDepth: 0 },
  { sessionId: 'session-stray', cwd: '/work/nowhere', delegationDepth: 0 },
  { sessionId: 'session-gone', cwd: '/work/gone', delegationDepth: 0 },
  { sessionId: 'session-arch', cwd: '/work/beta', delegationDepth: 0 },
  { sessionId: 'session-live', cwd: '/work/beta', delegationDepth: 0 },
  { sessionId: 'session-sub', cwd: '/work/beta', delegationDepth: 1 },
];

/** 生成默认计划。 */
async function planOf(overrides = {}) {
  return await buildPlan({
    sessions: SESSIONS,
    workspaces: WORKSPACES,
    archivedIds: new Set(['session-arch']),
    liveIds: new Set(['session-live']),
    canonicalize: fakeCanonicalize,
    ...overrides,
  });
}

test('buildPlan：五种分类各自归位且总数守恒', async () => {
  const plan = await planOf();
  assert.deepEqual(plan.reattachable.map((entry) => entry.sessionId), ['session-new']);
  assert.deepEqual(plan.accounted, ['session-a']);
  assert.deepEqual(plan.noWorkspace.map((entry) => entry.sessionId), ['session-stray']);
  assert.deepEqual(plan.invalid.map((entry) => entry.sessionId), ['session-gone']);
  assert.deepEqual(plan.skipped, {
    archived: ['session-arch'],
    live: ['session-live'],
    subagent: ['session-sub'],
  });
  assert.equal(plan.total, 7);
});

test('buildPlan：尾斜杠归一后仍能命中工作区，且 canonicalPath 已归一', async () => {
  const plan = await planOf();
  const [entry] = plan.reattachable;
  assert.equal(entry.workspaceId, 'w2');
  assert.equal(entry.workspaceTitle, 'beta');
  assert.equal(entry.canonicalPath, '/work/beta');
});

test('buildPlan：计划是 JSON 安全的（不夹带 sessionIds 与实体）', async () => {
  const plan = await planOf();
  assert.deepEqual(plan.workspaces, [
    { workspaceId: 'w1', title: 'alpha', path: '/work/alpha' },
    { workspaceId: 'w2', title: 'beta', path: '/work/beta' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
});

test('buildPlan：includeSubagents 打开后子代理会话进入可归位集合', async () => {
  const plan = await planOf({ includeSubagents: true });
  assert.deepEqual(plan.reattachable.map((entry) => entry.sessionId), ['session-new', 'session-sub']);
  assert.deepEqual(plan.skipped.subagent, []);
});

test('buildPlan：invalid 条目带原因码与人话', async () => {
  const plan = await planOf();
  const [entry] = plan.invalid;
  assert.equal(entry.reason, 'unresolvable');
  assert.match(entry.reasonText, /cwd 已失效/u);
  assert.equal(entry.cwd, '/work/gone');
});

test('buildPlan：空输入得到空计划而不是抛错', async () => {
  const plan = await buildPlan({ canonicalize: fakeCanonicalize });
  assert.deepEqual(plan.reattachable, []);
  assert.equal(plan.total, 0);
});

test('pickSession：只留目标会话，且 total 折为 1', async () => {
  const plan = await planOf({ includeSubagents: true });
  const picked = pickSession(plan, 'session-sub');
  assert.deepEqual(picked.reattachable.map((entry) => entry.sessionId), ['session-sub']);
  assert.deepEqual(picked.accounted, []);
  assert.equal(picked.total, 1);
});

test('pickSession：目标会话不在任何分类时全部为空', async () => {
  const plan = await planOf();
  const picked = pickSession(plan, 'session-does-not-exist');
  assert.deepEqual(picked.reattachable, []);
  assert.deepEqual(picked.noWorkspace, []);
  assert.deepEqual(picked.invalid, []);
  assert.deepEqual(picked.accounted, []);
});

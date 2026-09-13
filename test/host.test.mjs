// 宿主装配层测试：这一层是 ctx 与纯逻辑之间唯一的接触面。
// 重点是 MAX_SESSIONS 截断必须**如实上报**（否则报告会声称「没有可归位会话」而其实只是没看完）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SESSIONS,
  collectPlan,
  readArchivedIds,
  readLiveIds,
  readSessions,
  readWorkspaces,
} from '../lib/host.js';
import { fakeCanonicalize } from './helpers.mjs';

/** 造一个最小 ctx。 */
function fakeHostCtx(options = {}) {
  return {
    workspaceRegistry: {
      list: () => options.workspaces ?? [
        { id: 'w1', title: 'alpha', path: '/work/alpha', sessionIds: ['session-a'] },
      ],
      archivedSessionIds: options.archivedSessionIds ?? [],
    },
    sessionQuery: { listSessions: async () => options.records ?? [] },
    get: (key) => (key === 'sessions' ? options.sessions : undefined),
  };
}

/** 造 n 条会话记录。 */
function records(count, cwd = '/work/alpha') {
  return Array.from({ length: count }, (_unused, index) => ({ header: { id: `session-${index}`, cwd, delegationDepth: 0 } }));
}

test('readWorkspaces：只投影归位与汇报需要的字段', () => {
  const snapshot = readWorkspaces(fakeHostCtx());
  assert.deepEqual(snapshot, [{ workspaceId: 'w1', title: 'alpha', path: '/work/alpha', sessionIds: ['session-a'] }]);
});

test('readSessions：条数在上限内时不报截断', async () => {
  const result = await readSessions(fakeHostCtx({ records: records(3) }));
  assert.equal(result.sessions.length, 3);
  assert.equal(result.truncated, 0);
  assert.equal(result.malformed, 0);
});

test('readSessions：超过上限时明确报出被截断的条数', async () => {
  const result = await readSessions(fakeHostCtx({ records: records(MAX_SESSIONS + 7) }));
  assert.equal(result.sessions.length, MAX_SESSIONS);
  assert.equal(result.truncated, 7);
});

test('readSessions：缺 id 的记录计入 malformed 而不是截断', async () => {
  const mixed = [...records(2), { header: { cwd: '/work/alpha' } }];
  const result = await readSessions(fakeHostCtx({ records: mixed }));
  assert.equal(result.sessions.length, 2);
  assert.equal(result.malformed, 1);
  assert.equal(result.truncated, 0);
});

test('readLiveIds：sessions 服务缺席时按「没有活跃会话」处理', () => {
  assert.deepEqual([...readLiveIds(fakeHostCtx())], []);
  const live = readLiveIds(fakeHostCtx({ sessions: { list: () => [{ header: { id: 'session-live' } }] } }));
  assert.deepEqual([...live], ['session-live']);
});

test('readArchivedIds：归档集合转成字符串集合', () => {
  const archived = readArchivedIds(fakeHostCtx({ archivedSessionIds: ['session-arch'] }));
  assert.equal(archived.has('session-arch'), true);
});

test('collectPlan：把 malformed 与 truncated 一并挂到计划上', async () => {
  const ctx = fakeHostCtx({ records: records(MAX_SESSIONS + 2) });
  const plan = await collectPlan(ctx, { canonicalize: fakeCanonicalize });
  assert.equal(plan.truncated, 2);
  assert.equal(plan.malformed, 0);
  assert.equal(plan.total, MAX_SESSIONS);
});

test('collectPlan：includeSubagents 透传，会话头缺 cwd 时判为无法校验', async () => {
  const ctx = fakeHostCtx({
    records: [
      { header: { id: 'session-sub', cwd: '/work/alpha', delegationDepth: 1 } },
      { header: { id: 'session-nocwd', delegationDepth: 0 } },
    ],
  });
  const plan = await collectPlan(ctx, { canonicalize: fakeCanonicalize });
  assert.equal(plan.skipped.subagent.length, 1);
  assert.equal(plan.invalid.length, 1);
  assert.equal(plan.invalid[0].reason, 'no-cwd');

  const withSubagents = await collectPlan(ctx, { includeSubagents: true, canonicalize: fakeCanonicalize });
  assert.equal(withSubagents.skipped.subagent.length, 0);
});

test('collectPlan：空宿主也能产出可渲染的空计划', async () => {
  const plan = await collectPlan(fakeHostCtx(), { canonicalize: fakeCanonicalize });
  assert.equal(plan.total, 0);
  assert.equal(plan.truncated, 0);
  assert.equal(plan.malformed, 0);
  assert.deepEqual(plan.reattachable, []);
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
});

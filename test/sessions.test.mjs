// 会话投影测试：核心层只认 `{sessionId, cwd, delegationDepth}`，
// 缺 id 的记录必须被丢掉并计数（否则会给出一条无法执行的报告条目）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { projectSession, projectSessions } from '../lib/core/sessions.js';

test('projectSession：从 header 抽取三个字段', () => {
  const session = projectSession({ header: { id: 'session-1', cwd: '/work', delegationDepth: 2 } });
  assert.deepEqual(session, { sessionId: 'session-1', cwd: '/work', delegationDepth: 2 });
});

test('projectSession：delegationDepth 缺失或非法时按 0 处理', () => {
  assert.equal(projectSession({ header: { id: 'session-1', cwd: '/work' } }).delegationDepth, 0);
  assert.equal(projectSession({ header: { id: 'session-1', cwd: '/work', delegationDepth: 'x' } }).delegationDepth, 0);
});

test('projectSession：缺 id 或 id 为空串时返回 undefined', () => {
  assert.equal(projectSession({ header: { cwd: '/work' } }), undefined);
  assert.equal(projectSession({ header: { id: '', cwd: '/work' } }), undefined);
  assert.equal(projectSession({}), undefined);
  assert.equal(projectSession(undefined), undefined);
});

test('projectSessions：计数被丢弃的条数', () => {
  const { sessions, malformed } = projectSessions([
    { header: { id: 'session-1', cwd: '/work' } },
    { header: { cwd: '/work' } },
    { header: { id: 'session-2', cwd: '/elsewhere' } },
  ]);
  assert.deepEqual(sessions.map((session) => session.sessionId), ['session-1', 'session-2']);
  assert.equal(malformed, 1);
});

test('projectSessions：未提供记录时按空数组处理', () => {
  assert.deepEqual(projectSessions(undefined), { sessions: [], malformed: 0 });
});

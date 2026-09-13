// 汇报测试：拖拽落点的每条失败分支都必须有明确文案，
// 因为浏览器半边不再自己拼句子——它只显示宿主给的 message。

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeSingle, renderPlanReport } from '../lib/core/render.js';
import { planEntry, planFixture } from './helpers.mjs';

test('describeSingle：计划为空时报找不到会话', () => {
  const result = describeSingle(planFixture({ total: 0, reattachable: [] }), 'session-x');
  assert.equal(result.status, 'unknown');
  assert.equal(result.code, 'session-not-found');
});

test('describeSingle：三类跳过各有自己的结论', () => {
  const skipped = { archived: ['session-arch'], live: ['session-live'], subagent: ['session-sub'] };
  const plan = planFixture({ total: 3, reattachable: [], skipped });
  assert.equal(describeSingle(plan, 'session-live').code, 'session-live');
  assert.equal(describeSingle(plan, 'session-arch').code, 'session-archived');
  assert.equal(describeSingle(plan, 'session-sub').code, 'session-subagent');
});

test('describeSingle：cwd 不合法时带上原因与路径', () => {
  const plan = planFixture({
    total: 1,
    reattachable: [],
    invalid: [{ sessionId: 'session-gone', cwd: '/work/gone', reason: 'unresolvable', reasonText: 'cwd 已失效（目录被移动、改名或不可访问）' }],
  });
  const result = describeSingle(plan, 'session-gone');
  assert.equal(result.code, 'cwd-invalid');
  assert.match(result.message, /cwd 已失效/u);
  assert.match(result.message, /\/work\/gone/u);
});

test('describeSingle：无匹配工作区时给出「先建工作区」的下一步', () => {
  const plan = planFixture({
    total: 1,
    reattachable: [],
    noWorkspace: [{ sessionId: 'session-stray', cwd: '/work/nowhere', canonicalPath: '/work/nowhere' }],
  });
  const result = describeSingle(plan, 'session-stray');
  assert.equal(result.code, 'no-workspace');
  assert.match(result.message, /没有任何工作区记录这个目录/u);
});

test('describeSingle：已归属时报无需动作', () => {
  const plan = planFixture({ total: 1, reattachable: [], accounted: ['session-a'] });
  const result = describeSingle(plan, 'session-a');
  assert.equal(result.status, 'noop');
  assert.equal(result.code, 'already-accounted');
});

test('describeSingle：不指定落点或落点正确时都判定可归位', () => {
  const plan = planFixture();
  assert.equal(describeSingle(plan, 'session-new').status, 'ready');
  assert.equal(describeSingle(plan, 'session-new', 'w2').status, 'ready');
});

test('describeSingle：落点错误时点名「只能去哪个、不能去哪个」', () => {
  const result = describeSingle(planFixture(), 'session-new', 'w1');
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'workspace-mismatch');
  assert.match(result.message, /只能归位到「beta」/u);
  assert.match(result.message, /不能归位到「alpha」/u);
});

test('describeSingle：落点工作区不存在时报 workspace-not-found', () => {
  const result = describeSingle(planFixture(), 'session-new', 'w9');
  assert.equal(result.code, 'workspace-not-found');
});

test('describeSingle：会话不在任何分类里时报找不到', () => {
  const result = describeSingle(planFixture(), 'session-unknown');
  assert.equal(result.code, 'session-not-found');
  assert.equal(result.status, 'unknown');
});

test('renderPlanReport：dry-run 报告列出可归位并给出下一步', () => {
  const many = Array.from({ length: 15 }, (_unused, index) => planEntry({ sessionId: `session-${index}` }));
  const text = renderPlanReport({ plan: planFixture({ total: 15, reattachable: many }), dryRun: true, maxItems: 3 });
  assert.match(text, /会话归位 · dry-run（未写入任何内容）/u);
  assert.match(text, /可归位 15 个：/u);
  assert.match(text, /…另有 12 个未列出/u);
  assert.match(text, /执行：\/reattach apply/u);
  assert.match(text, /陈旧归属槽位/u);
});

test('renderPlanReport：执行模式分别汇报已归位与失败', () => {
  const applied = [
    { sessionId: 'session-new', status: 'attached', workspaceId: 'w2', workspaceTitle: 'beta' },
    { sessionId: 'session-bad', status: 'failed', code: 'attach-rejected', message: 'DSH 拒绝归属：cwd 不匹配' },
  ];
  const text = renderPlanReport({ plan: planFixture(), applied, dryRun: false });
  assert.match(text, /会话归位 · 已执行/u);
  assert.match(text, /已归位 1 个：/u);
  assert.match(text, /失败 1 个：/u);
  assert.match(text, /DSH 拒绝归属/u);
});

test('renderPlanReport：候选窗口被截断时必须明说，不得假装看全了', () => {
  const text = renderPlanReport({ plan: planFixture({ total: 5000, reattachable: [], truncated: 120 }), dryRun: true });
  assert.match(text, /还有 120 个更早的会话未参与判定/u);
  const clean = renderPlanReport({ plan: planFixture({ total: 1, reattachable: [], truncated: 0 }), dryRun: true });
  assert.doesNotMatch(clean, /未参与判定/u);
});

test('renderPlanReport：无 truncation 字段时也能渲染', () => {
  const text = renderPlanReport({ plan: planFixture({ total: 0, reattachable: [], truncated: undefined }), dryRun: true });
  assert.match(text, /没有需要归位的会话。/u);
  assert.doesNotMatch(text, /undefined/u);
});

test('renderPlanReport：无事可做时直说', () => {
  const text = renderPlanReport({ plan: planFixture({ total: 0, reattachable: [] }), dryRun: true });
  assert.match(text, /没有需要归位的会话。/u);
});

test('renderPlanReport：跳过统计与两类问题段落都按条数汇报', () => {
  const plan = planFixture({
    total: 4,
    reattachable: [],
    accounted: ['session-a'],
    skipped: { archived: ['a', 'b'], live: ['c'], subagent: [] },
    noWorkspace: [{ sessionId: 'session-stray', cwd: '/work/nowhere', canonicalPath: '/work/nowhere' }],
    invalid: [{ sessionId: 'session-gone', cwd: undefined, reason: 'no-cwd', reasonText: '会话头没有 cwd，无法校验' }],
  });
  const text = renderPlanReport({ plan, dryRun: true });
  assert.match(text, /无匹配工作区 1 个：/u);
  assert.match(text, /cwd 无法校验 1 个：/u);
  assert.match(text, /跳过：已归档 2 个、运行中 1 个/u);
  assert.match(text, /已归属、无需动作：1 个/u);
  assert.doesNotMatch(text, /undefined/u);
});

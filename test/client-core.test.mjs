// 浏览器半边纯逻辑测试：落点判定与提示文案都在这里定，
// DOM 侧只负责把事件喂进来（见 client.test.mjs 的行为测试）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUTE_PATH,
  STATE_PATH,
  applyBody,
  decideDrop,
  isSessionId,
  parseState,
  sameTitle,
  targetOf,
  textOf,
  toastFor,
} from '../lib/client-core.js';

const SESSION = 'session-4f8a1c2e-7b3d-4e5f-8a9b-0c1d2e3f4a5b';
const SUBAGENT = '09854d35-7317-4b38-bb64-26007552669a';

const STATE_PAYLOAD = {
  ok: true,
  workspaces: [{ workspaceId: 'w2', title: 'beta', path: '/work/beta' }],
  sessions: [{ sessionId: SESSION, workspaceId: 'w2', workspaceTitle: 'beta' }],
};

test('路由常量与宿主保持一致', () => {
  assert.equal(ROUTE_PATH, '/session-reattach');
  assert.equal(STATE_PATH, '/session-reattach/state');
});

test('isSessionId：接受 session- 前缀与裸 uuid，拒绝其它文本', () => {
  assert.equal(isSessionId(SESSION), true);
  assert.equal(isSessionId(SUBAGENT), true);
  assert.equal(isSessionId(` ${SESSION} `), true);
  assert.equal(isSessionId('session-not-a-uuid'), false);
  assert.equal(isSessionId('/home/user/Project'), false);
  assert.equal(isSessionId(''), false);
  assert.equal(isSessionId(undefined), false);
  assert.equal(isSessionId(42), false);
});

test('parseState：解析出目标映射与标题清单', () => {
  const state = parseState(STATE_PAYLOAD);
  assert.deepEqual(state.titles, ['beta']);
  assert.deepEqual(targetOf(state, SESSION), { sessionId: SESSION, workspaceId: 'w2', workspaceTitle: 'beta' });
  assert.equal(targetOf(state, 'session-00000000-0000-0000-0000-000000000000'), undefined);
});

test('parseState：形状不对时返回 undefined（失败关闭）', () => {
  assert.equal(parseState(undefined), undefined);
  assert.equal(parseState({}), undefined);
  assert.equal(parseState({ ok: false, sessions: [], workspaces: [] }), undefined);
  assert.equal(parseState({ ok: true, sessions: 'nope', workspaces: [] }), undefined);
  assert.equal(parseState({ ok: true, sessions: [], workspaces: 'nope' }), undefined);
});

test('parseState：跳过缺字段的条目', () => {
  const state = parseState({ ok: true, workspaces: [], sessions: [{ sessionId: SESSION }, { workspaceId: 'w2' }] });
  assert.equal(state.targets.size, 0);
});

test('decideDrop：目标分组放行，其它分组拒绝，未知会话交给宿主', () => {
  const state = parseState(STATE_PAYLOAD);
  assert.equal(decideDrop(state, SESSION, 'beta'), 'allow-target');
  assert.equal(decideDrop(state, SESSION, ' beta '), 'allow-target');
  assert.equal(decideDrop(state, SESSION, 'alpha'), 'reject');
  assert.equal(decideDrop(state, SUBAGENT, 'alpha'), 'allow-unknown');
  assert.equal(decideDrop(undefined, SESSION, 'alpha'), 'allow-unknown');
});

test('applyBody：显式写入 dryRun:false，落点未知时不编造 workspaceId', () => {
  assert.deepEqual(applyBody(SESSION, 'w2'), { sessionId: SESSION, workspaceId: 'w2', dryRun: false });
  assert.deepEqual(applyBody(SESSION, undefined), { sessionId: SESSION, dryRun: false });
});

test('toastFor：成功、无需动作、被拒绝、无法识别四种结果', () => {
  const attached = toastFor({ ok: true, applied: [{ status: 'attached', workspaceTitle: 'beta' }] });
  assert.deepEqual(attached, { ok: true, text: '已归位到「beta」。' });
  const noop = toastFor({ ok: true, single: { status: 'noop', message: '这个会话已经有归属，无需归位。' } });
  assert.equal(noop.ok, true);
  const rejected = toastFor({ ok: true, single: { status: 'rejected', message: '未归位：cwd 已失效（/old）。' } });
  assert.deepEqual(rejected, { ok: false, text: '未归位：cwd 已失效（/old）。' });
  assert.equal(toastFor(undefined).ok, false);
  assert.match(toastFor({ ok: true }).text, /无法识别/u);
});

test('toastFor：成功但没带标题时回落到已知标题', () => {
  const result = toastFor({ ok: true, applied: [{ status: 'attached' }] }, 'beta');
  assert.equal(result.text, '已归位到「beta」。');
});

test('toastFor：全量模式的失败条目也能显示', () => {
  const result = toastFor({ ok: true, applied: [], failed: [{ sessionId: SESSION, message: 'DSH 拒绝归属：cwd 不匹配' }] });
  assert.deepEqual(result, { ok: false, text: 'DSH 拒绝归属：cwd 不匹配' });
});

test('textOf / sameTitle：去空白后比较，空标题不算相同', () => {
  assert.equal(textOf('  beta '), 'beta');
  assert.equal(textOf(undefined), '');
  assert.equal(sameTitle('beta', ' beta '), true);
  assert.equal(sameTitle('', ''), false);
  assert.equal(sameTitle('beta', 'alpha'), false);
});

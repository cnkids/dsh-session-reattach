// 执行测试：重点是「先 detach 其余工作区、再 attach 目标」这个顺序。
// 顺序错了会在落盘状态里留下双归属，下次启动 dsh 时 workspace registry 校验直接抛错。

import test from 'node:test';
import assert from 'node:assert/strict';

import { executePlan, summarizeResults } from '../lib/core/execute.js';
import { fakeWorkspace, planEntry } from './helpers.mjs';

/** 造两个工作区实体与共享调用日志。 */
function fixture(options = {}) {
  const log = [];
  const alpha = fakeWorkspace('/work/alpha', options.alpha ?? {}, log);
  const beta = fakeWorkspace('/work/beta', options.beta ?? {}, log);
  const workspaces = [alpha, beta];
  const deps = {
    workspaces,
    resolve: (workspaceId) => workspaces.find((workspace) => workspace.path === (workspaceId === 'w1' ? '/work/alpha' : '/work/beta')),
  };
  return { log, deps };
}

test('executePlan：先从其余工作区清槽位，再 attach 目标', async () => {
  const { log, deps } = fixture();
  const results = await executePlan({ reattachable: [planEntry({ workspaceId: 'w2' })] }, deps);
  assert.deepEqual(log, ['detach:/work/alpha:session-new', 'attach:/work/beta:session-new']);
  assert.equal(results[0].status, 'attached');
  assert.equal(results[0].workspaceTitle, 'beta');
});

test('executePlan：目标工作区自己不会被 detach', async () => {
  const { log, deps } = fixture();
  await executePlan({ reattachable: [planEntry({ workspaceId: 'w1' })] }, deps);
  assert.equal(log.filter((entry) => entry.startsWith('detach:/work/alpha')).length, 0);
  assert.deepEqual(log, ['detach:/work/beta:session-new', 'attach:/work/alpha:session-new']);
});

test('executePlan：attach 被拒绝时折成失败条目，不中断其它会话', async () => {
  const { deps } = fixture({ beta: { failAttach: true } });
  const results = await executePlan({
    reattachable: [planEntry({ sessionId: 'session-1' }), planEntry({ sessionId: 'session-2' })],
  }, deps);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((result) => result.status), ['failed', 'failed']);
  assert.equal(results[0].code, 'attach-rejected');
  assert.match(results[0].message, /attach boom/u);
});

test('executePlan：清槽位失败时放弃 attach（失败关闭，绝不冒双归属的险）', async () => {
  const { log, deps } = fixture({ alpha: { failDetach: true } });
  const results = await executePlan({ reattachable: [planEntry()] }, deps);
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].code, 'stale-cleanup-failed');
  assert.equal(log.filter((entry) => entry.startsWith('attach:')).length, 0);
});

test('executePlan：目标工作区已消失时报 workspace-not-found', async () => {
  const { deps } = fixture();
  const results = await executePlan({ reattachable: [planEntry({ workspaceId: 'w9' })] }, { ...deps, resolve: () => undefined });
  assert.equal(results[0].code, 'workspace-not-found');
  assert.match(results[0].message, /已不存在/u);
});

test('executePlan：空计划不产生任何调用', async () => {
  const { log, deps } = fixture();
  assert.deepEqual(await executePlan({ reattachable: [] }, deps), []);
  assert.deepEqual(await executePlan({}, deps), []);
  assert.deepEqual(log, []);
});

test('summarizeResults：统计已归位与失败', () => {
  assert.deepEqual(summarizeResults([
    { status: 'attached' },
    { status: 'failed' },
    { status: 'attached' },
  ]), { attached: 2, failed: 1 });
  assert.deepEqual(summarizeResults(undefined), { attached: 0, failed: 0 });
});

// 命令测试：/reattach 是拖拽失效后的兜底通道，必须永远可用、永远不猜意图。

import test from 'node:test';
import assert from 'node:assert/strict';

import { COMMAND_NAME, USAGE, createReattachCommand, parseArgs } from '../lib/command.js';
import { planFixture } from './helpers.mjs';

/** 造一份可注入的依赖，记录 execute 与 collectPlan 的调用参数。 */
function makeDeps(options = {}) {
  const state = { executed: 0, planOptions: [] };
  const deps = {
    collectPlan: async (planOptions) => {
      if (options.planThrows === true) throw new Error('collect boom');
      state.planOptions.push(planOptions);
      return planFixture(options.plan);
    },
    execute: async () => {
      state.executed += 1;
      return [{ sessionId: 'session-new', status: 'attached', workspaceId: 'w2', workspaceTitle: 'beta' }];
    },
  };
  return { deps, state };
}

test('parseArgs：只认 apply 与 subagents，可任意顺序', () => {
  assert.deepEqual(parseArgs(''), { mode: 'dry-run', includeSubagents: false });
  assert.deepEqual(parseArgs(undefined), { mode: 'dry-run', includeSubagents: false });
  assert.deepEqual(parseArgs('   '), { mode: 'dry-run', includeSubagents: false });
  assert.deepEqual(parseArgs('apply'), { mode: 'apply', includeSubagents: false });
  assert.deepEqual(parseArgs(' APPLY '), { mode: 'apply', includeSubagents: false });
  assert.deepEqual(parseArgs('apply subagents'), { mode: 'apply', includeSubagents: true });
  assert.deepEqual(parseArgs('subagents apply'), { mode: 'apply', includeSubagents: true });
  assert.deepEqual(parseArgs('subagents'), { mode: 'dry-run', includeSubagents: true });
  assert.deepEqual(parseArgs('apply now'), { invalid: true });
  assert.deepEqual(parseArgs('--force'), { invalid: true });
});

test('命令定义：名字与描述齐备', () => {
  const command = createReattachCommand(makeDeps().deps);
  assert.equal(command.name, COMMAND_NAME);
  assert.match(command.description, /归位/u);
});

test('无参数时只 dry-run，不写入', async () => {
  const { deps, state } = makeDeps();
  const result = await createReattachCommand(deps).handler({ rawInput: '' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /dry-run/u);
  assert.equal(state.executed, 0);
});

test('apply 才执行归位', async () => {
  const { deps, state } = makeDeps();
  const result = await createReattachCommand(deps).handler({ rawInput: ' apply ' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /已执行/u);
  assert.equal(state.executed, 1);
});

test('无法识别的参数回用法错误，不执行也不汇报', async () => {
  const { deps, state } = makeDeps();
  const result = await createReattachCommand(deps).handler({ rawInput: 'nuke' });
  assert.equal(result.kind, 'error');
  assert.equal(result.text, USAGE);
  assert.equal(state.executed, 0);
  assert.deepEqual(state.planOptions, []);
});

test('subagents 参数会透传给计划装配', async () => {
  const { deps, state } = makeDeps();
  await createReattachCommand(deps).handler({ rawInput: 'subagents' });
  await createReattachCommand(deps).handler({ rawInput: '' });
  assert.deepEqual(state.planOptions, [{ includeSubagents: true }, { includeSubagents: false }]);
});

test('数据装配失败时折成错误结果而不是抛出', async () => {
  const { deps } = makeDeps({ planThrows: true });
  const result = await createReattachCommand(deps).handler({ rawInput: '' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /collect boom/u);
});

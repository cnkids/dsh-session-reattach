// `/reattach` 斜杠命令：手工 dry-run 与执行，不经过模型。
//
// 保留这个入口的理由：拖拽依赖浏览器 DOM 结构，一旦上游改了侧边栏，拖拽会静默失效；
// 命令只依赖宿主服务，永远可用，是排查与兜底通道。

import { renderPlanReport } from './core/render.js';

/** 命令名（不带前导斜杠）。 */
export const COMMAND_NAME = 'reattach';
/** 用法提示。 */
export const USAGE = '用法：/reattach [apply] [subagents]'
  + '（不带 apply 只做 dry-run；subagents 连带处理子代理会话）';
/** 命令描述，出现在命令发现列表里。 */
export const COMMAND_DESCRIPTION = '把游离（未分组）会话按 cwd 归位到匹配的工作区：先 dry-run，确认后 apply。';

/**
 * 创建命令定义。
 * @param {object} deps 依赖，与 HTTP 路由共用同一套。
 * @param {Function} deps.collectPlan 生成完整计划。
 * @param {Function} deps.execute 执行计划。
 * @returns {object} `ctx.commands.register` 接受的定义。
 */
export function createReattachCommand(deps) {
  return {
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    handler: (invocation) => run(deps, invocation?.rawInput),
  };
}

/**
 * 解析参数：只认 `apply` 与 `subagents`（可任意顺序），其余一律用法错误。
 *
 * 刻意不猜意图：把无法识别的参数当「默认执行」或「默认忽略」都会让用户以为生效了。
 * @param {unknown} rawInput 命令名之后的原文。
 * @returns {{mode: 'dry-run'|'apply', includeSubagents: boolean} | {invalid: true}} 解析结果。
 */
export function parseArgs(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput : '';
  const tokens = text.trim().toLowerCase().split(/\s+/u).filter((token) => token !== '');
  const parsed = { mode: 'dry-run', includeSubagents: false };
  for (const token of tokens) {
    if (token === 'apply') parsed.mode = 'apply';
    else if (token === 'subagents') parsed.includeSubagents = true;
    else return { invalid: true };
  }
  return parsed;
}

/**
 * 执行一次命令调用。
 * @param {object} deps 依赖。
 * @param {unknown} rawInput 命令名之后的原文。
 * @returns {Promise<object>} 命令结果。
 */
async function run(deps, rawInput) {
  const args = parseArgs(rawInput);
  if (args.invalid === true) return { kind: 'error', text: USAGE };
  try {
    const plan = await deps.collectPlan({ includeSubagents: args.includeSubagents });
    if (args.mode === 'dry-run') return { kind: 'success', text: renderPlanReport({ plan, dryRun: true }) };
    const applied = await deps.execute(plan);
    return { kind: 'success', text: renderPlanReport({ plan, applied, dryRun: false }) };
  } catch (error) {
    return { kind: 'error', text: `归位失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

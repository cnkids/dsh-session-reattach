// 宿主侧数据装配：把 ctx 上的服务读成归位核心要的纯数据。
//
// 与 ctx 的全部接触都收在这一层，于是 core/ 可以脱离 cordis 单测，
// 而 http/command 两层也能用假 deps 单测。

import { buildPlan } from './core/plan.js';
import { projectSessions } from './core/sessions.js';

/** 会话列表一次性最多读取的条数上限：会话极多时避免把整棵树读爆。 */
export const MAX_SESSIONS = 5000;

/**
 * 读取工作区快照。
 * @param {object} ctx 宿主上下文，需带 workspaceRegistry 服务。
 * @returns {Array<object>} 工作区快照数组。
 */
export function readWorkspaces(ctx) {
  return ctx.workspaceRegistry.list().map((workspace) => ({
    workspaceId: String(workspace.id),
    title: workspace.title,
    path: workspace.path,
    sessionIds: [...workspace.sessionIds],
  }));
}

/**
 * 读取会话快照（live 优先，含持久化的冷会话）。
 *
 * `listSessions()` 按「最新优先」返回，因此截断丢掉的是**更早**的会话。截断数必须
 * 一路带到报告里：否则会话超过上限时，工具会声称「没有需要归位的会话」，
 * 而实际只是没看那么多（与 palimpsest「候选窗口装不下就明说」的口径一致）。
 * @param {object} ctx 宿主上下文，需带 sessionQuery 服务。
 * @returns {Promise<{sessions: Array<object>, malformed: number, truncated: number}>} 快照、被丢弃条数与被截断条数。
 */
export async function readSessions(ctx) {
  const records = await ctx.sessionQuery.listSessions();
  const all = records ?? [];
  const bounded = all.slice(0, MAX_SESSIONS);
  return { ...projectSessions(bounded), truncated: Math.max(0, all.length - bounded.length) };
}

/**
 * 读取本进程活跃会话 id。`sessions` 服务在某些组装下不存在，取不到就按「没有活跃会话」处理：
 * 这只影响跳过策略的精度，不会让归位出错（活跃会话本来就已经归属）。
 * @param {object} ctx 宿主上下文。
 * @returns {Set<string>} 活跃会话 id 集合。
 */
export function readLiveIds(ctx) {
  const sessions = ctx.get('sessions');
  if (sessions === undefined) return new Set();
  return new Set(sessions.list().map((session) => String(session.header.id)));
}

/** 读取已归档会话 id。 */
export function readArchivedIds(ctx) {
  return new Set(ctx.workspaceRegistry.archivedSessionIds.map(String));
}

/**
 * 组装一次完整计划。
 * @param {object} ctx 宿主上下文。
 * @param {object} [options] 选项。
 * @param {boolean} [options.includeSubagents] 是否纳入子代理会话。
 * @param {Function} [options.canonicalize] cwd 规范化函数，仅测试使用。
 * @returns {Promise<object>} 归位计划。
 */
export async function collectPlan(ctx, options = {}) {
  const { sessions, malformed, truncated } = await readSessions(ctx);
  const plan = await buildPlan({
    sessions,
    workspaces: readWorkspaces(ctx),
    archivedIds: readArchivedIds(ctx),
    liveIds: readLiveIds(ctx),
    includeSubagents: options.includeSubagents === true,
    canonicalize: options.canonicalize,
  });
  plan.malformed = malformed;
  plan.truncated = truncated;
  return plan;
}

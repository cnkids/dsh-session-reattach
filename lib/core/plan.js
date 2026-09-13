// 归位计划：把「所有会话」+「所有工作区」折成可执行、可汇报的分类结果。
//
// 这一层是纯逻辑：不读文件、不写归属、不碰 ctx。cwd 的规范化通过 `canonicalize`
// 注入，测试里换成同步假实现即可，不必真的造目录。

import { canonicalDirectory, INVALID_CWD_REASONS } from './paths.js';

/** 归属判定的五种结果，逐条对应 DSH `attachSession` 的校验分支。 */
export const OUTCOMES = Object.freeze({
  /** cwd 有效且命中某个工作区 → 可归位。 */
  reattachable: 'reattachable',
  /** 已在该工作区的有效归属里 → 无需动作。 */
  accounted: 'accounted',
  /** cwd 有效但没有任何工作区记录这个目录。 */
  noWorkspace: 'noWorkspace',
  /** cwd 本身不合法（缺失 / 非绝对 / 失效 / 不是目录）。 */
  invalid: 'invalid',
  /** 按策略跳过（已归档 / 运行中 / 子代理）。 */
  skipped: 'skipped',
});

/** 跳过的原因码 → 人话。 */
export const SKIP_REASONS = Object.freeze({
  archived: '已归档',
  live: '运行中',
  subagent: '子代理会话',
});

/**
 * 生成一份归位计划。
 * @param {object} options 计划输入。
 * @param {readonly object[]} options.sessions 已投影的会话（`{sessionId, cwd, delegationDepth}`）。
 * @param {readonly object[]} options.workspaces 工作区快照（`{workspaceId, title, path, sessionIds}`）。
 * @param {Set<string>} [options.archivedIds] 已归档会话 id。
 * @param {Set<string>} [options.liveIds] 本进程活跃会话 id。
 * @param {boolean} [options.includeSubagents] 是否把子代理会话也纳入归位。
 * @param {Function} [options.canonicalize] cwd 规范化函数，默认本插件 realpath 实现。
 * @returns {Promise<object>} 计划（JSON 安全，可直接回给浏览器）。
 */
export async function buildPlan(options) {
  const context = {
    archivedIds: options.archivedIds ?? new Set(),
    liveIds: options.liveIds ?? new Set(),
    includeSubagents: options.includeSubagents === true,
    canonicalize: options.canonicalize ?? canonicalDirectory,
    byPath: new Map((options.workspaces ?? []).map((workspace) => [workspace.path, workspace])),
  };
  const plan = {
    workspaces: (options.workspaces ?? []).map(projectWorkspace),
    reattachable: [],
    accounted: [],
    noWorkspace: [],
    invalid: [],
    skipped: { archived: [], live: [], subagent: [] },
    total: 0,
  };
  for (const session of options.sessions ?? []) {
    plan.total += 1;
    await classifyInto(plan, session, context);
  }
  return plan;
}

/** 工作区快照投影：只保留汇报与客户端预筛需要的字段。 */
function projectWorkspace(workspace) {
  return {
    workspaceId: String(workspace.workspaceId),
    title: workspace.title,
    path: workspace.path,
  };
}

/**
 * 判定一条会话并写入对应分类。
 * @param {object} plan 计划累加器。
 * @param {object} session 已投影的会话。
 * @param {object} context 判定上下文。
 * @returns {Promise<void>} 判定完成后写入 plan。
 */
async function classifyInto(plan, session, context) {
  const skip = skipReason(session, context);
  if (skip !== undefined) {
    plan.skipped[skip].push(session.sessionId);
    return;
  }
  const canonical = await context.canonicalize(session.cwd);
  if (!canonical.ok) {
    plan.invalid.push(invalidEntry(session, canonical.reason));
    return;
  }
  const target = context.byPath.get(canonical.path);
  if (target === undefined) {
    plan.noWorkspace.push({ sessionId: session.sessionId, cwd: session.cwd, canonicalPath: canonical.path });
    return;
  }
  if (isAccounted(target, session.sessionId)) {
    plan.accounted.push(session.sessionId);
    return;
  }
  plan.reattachable.push(reattachableEntry(session, canonical.path, target));
}

/** 按策略给出的跳过原因；不跳过时返回 undefined。 */
function skipReason(session, context) {
  if (context.archivedIds.has(session.sessionId)) return 'archived';
  if (context.liveIds.has(session.sessionId)) return 'live';
  if (!context.includeSubagents && session.delegationDepth > 0) return 'subagent';
  return undefined;
}

/** 是否已在该工作区的**有效**归属里（getter 已按 canonical cwd 过滤过）。 */
function isAccounted(workspace, sessionId) {
  return (workspace.sessionIds ?? []).includes(sessionId);
}

/** cwd 不合法条目。 */
function invalidEntry(session, reason) {
  return {
    sessionId: session.sessionId,
    cwd: typeof session.cwd === 'string' ? session.cwd : undefined,
    reason,
    reasonText: INVALID_CWD_REASONS[reason] ?? 'cwd 无法校验',
  };
}

/** 可归位条目。 */
function reattachableEntry(session, canonicalPath, workspace) {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    canonicalPath,
    workspaceId: String(workspace.workspaceId),
    workspaceTitle: workspace.title,
    workspacePath: workspace.path,
  };
}

/**
 * 只保留指定会话的可归位条目，用于拖拽落点这种「一次一个会话」的调用。
 *
 * 目标工作区不匹配时不做过滤，交由调用方按原因分类：把 `workspaceId` 的比较放在
 * 这里会让「拖错分组」与「cwd 不匹配」两种原因混在一起，汇报会失真。
 * @param {object} plan 完整计划。
 * @param {string} sessionId 目标会话。
 * @returns {object} 只含该会话的计划切片。
 */
export function pickSession(plan, sessionId) {
  const holder = (entry) => entry.sessionId === sessionId;
  return {
    ...plan,
    reattachable: plan.reattachable.filter(holder),
    accounted: plan.accounted.filter((id) => id === sessionId),
    noWorkspace: plan.noWorkspace.filter(holder),
    invalid: plan.invalid.filter(holder),
    skipped: {
      archived: plan.skipped.archived.filter((id) => id === sessionId),
      live: plan.skipped.live.filter((id) => id === sessionId),
      subagent: plan.skipped.subagent.filter((id) => id === sessionId),
    },
    total: 1,
  };
}

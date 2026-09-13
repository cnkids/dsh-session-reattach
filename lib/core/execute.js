// 执行归位计划。
//
// 两个必须按顺序发生的写入：
//   1. 先从**其余**工作区清掉该会话的陈旧槽位；
//   2. 再调用目标工作区的 `attachSession`。
//
// 顺序不能反，也不能省。原因在 dsh-workspace 的双归属不变量：
// `validateStoredState()` 在**启动时**校验「同一个 sessionId 不能同时出现在两个
// workspace 的 sessionIds 里」，违反就直接抛错、工作区域整体不可用。而
// `entity.sessionIds` getter 只按 canonical cwd 过滤返回值，**不会**清理落盘的
// `record.sessionIds`——陈旧槽位要等下一次 `mutate` 才被顺带剪枝。
//
// 于是「会话被移动过（首帧 cwd 被改写）」这种场景下，旧工作区 JSON 里仍留着该 id：
// 此时若只 attach 不 detach，落盘状态就是双归属，下次启动即失败。
// `detachSession` 对「本来就不在其中」的工作区是空操作（记录未变且无可剪枝项时
// 走内部 sentinel，不写盘），所以无条件对非目标工作区调用是安全的。

/**
 * 执行计划里所有可归位条目。
 * @param {object} plan `buildPlan` 的结果。
 * @param {object} deps 执行依赖。
 * @param {Function} deps.resolve `(workspaceId) => Workspace|undefined`，按 id 取工作区实体。
 * @param {readonly object[]} deps.workspaces 全部工作区实体，用于清理陈旧槽位。
 * @returns {Promise<Array<object>>} 每条会话的执行结果。
 */
export async function executePlan(plan, deps) {
  const results = [];
  for (const item of plan.reattachable ?? []) {
    results.push(await attachOne(item, deps));
  }
  return results;
}

/**
 * 归位一条会话；任何失败都折成结果对象，不让单点失败中断整批。
 * @param {object} item 可归位条目。
 * @param {object} deps 执行依赖。
 * @returns {Promise<object>} 该条的执行结果。
 */
async function attachOne(item, deps) {
  const target = deps.resolve(item.workspaceId);
  if (target === undefined) {
    return failure(item, 'workspace-not-found', `工作区 ${item.workspaceId} 已不存在，未归位`);
  }
  try {
    await cleanStaleOwners(item.sessionId, target, deps.workspaces ?? []);
  } catch (error) {
    return failure(item, 'stale-cleanup-failed', `清理陈旧归属记录失败，已放弃归位以免产生双归属：${messageOf(error)}`);
  }
  try {
    await target.attachSession(item.sessionId);
  } catch (error) {
    return failure(item, 'attach-rejected', `DSH 拒绝归属：${messageOf(error)}`);
  }
  return {
    sessionId: item.sessionId,
    status: 'attached',
    workspaceId: item.workspaceId,
    workspaceTitle: item.workspaceTitle,
    cwd: item.cwd,
  };
}

/**
 * 从其余工作区清掉该会话的陈旧槽位。
 * @param {string} sessionId 会话 id。
 * @param {object} target 目标工作区实体。
 * @param {readonly object[]} workspaces 全部工作区实体。
 * @returns {Promise<void>} 全部清理调用返回后 resolve。
 */
async function cleanStaleOwners(sessionId, target, workspaces) {
  for (const workspace of workspaces) {
    if (workspace.path === target.path) continue;
    await workspace.detachSession(sessionId);
  }
}

/** 失败结果。 */
function failure(item, code, message) {
  return { sessionId: item.sessionId, status: 'failed', code, message };
}

/** 把任意抛出物折成可读文本。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 汇总执行结果计数，供汇报使用。
 * @param {readonly object[]} results `executePlan` 的结果。
 * @returns {{attached: number, failed: number}} 计数。
 */
export function summarizeResults(results) {
  let attached = 0;
  let failed = 0;
  for (const result of results ?? []) {
    if (result.status === 'attached') attached += 1;
    else failed += 1;
  }
  return { attached, failed };
}

// 把 DSH 的会话记录投影成本插件自己的最小形状。
//
// 独立成一层是为了让归位核心（plan/execute）不依赖 DSH 的记录结构：
// 单元测试可以直接喂投影后的对象，不需要伪造整个 ctx.sessionQuery。

/**
 * 把一条 `sessionQuery.listSessions()` 记录投影成 `{sessionId, cwd, delegationDepth}`。
 *
 * 取不到 id 的记录返回 `undefined`：没有 id 就无法调用 `attachSession`，
 * 也无法给出可执行的报告条目，只能整条丢弃（调用方计入 malformed）。
 * @param {unknown} record 会话记录，期望带 `header`。
 * @returns {{sessionId: string, cwd: unknown, delegationDepth: number} | undefined} 投影结果。
 */
export function projectSession(record) {
  const header = record?.header ?? record;
  const sessionId = typeof header?.id === 'string' && header.id !== '' ? header.id : undefined;
  if (sessionId === undefined) return undefined;
  return {
    sessionId,
    cwd: header.cwd,
    delegationDepth: Number.isFinite(header.delegationDepth) ? header.delegationDepth : 0,
  };
}

/**
 * 批量投影，并回报被丢弃的条数。
 * @param {readonly unknown[]} records 会话记录数组。
 * @returns {{sessions: Array<object>, malformed: number}} 投影结果与缺 id 的条数。
 */
export function projectSessions(records) {
  const sessions = [];
  let malformed = 0;
  for (const record of records ?? []) {
    const session = projectSession(record);
    if (session === undefined) malformed += 1;
    else sessions.push(session);
  }
  return { sessions, malformed };
}

// 汇报渲染：把计划与执行结果折成给人看的文本（命令回执），
// 以及把「拖拽落点」的单会话判定折成一条可直接显示的结论。

/** 单会话结论的状态。 */
export const SINGLE_STATUS = Object.freeze({
  ready: 'ready',
  noop: 'noop',
  rejected: 'rejected',
  unknown: 'unknown',
});

/**
 * 渲染一份归位报告。
 * @param {object} options 渲染输入。
 * @param {object} options.plan `buildPlan` 的结果。
 * @param {readonly object[]} [options.applied] `executePlan` 的结果（dry-run 时省略）。
 * @param {boolean} options.dryRun 是否只报告不写入。
 * @param {number} [options.maxItems] 每个分类最多列出几条。
 * @returns {string} 报告文本。
 */
export function renderPlanReport(options) {
  const { plan, applied, dryRun, maxItems = 10 } = options;
  return [
    dryRun ? '会话归位 · dry-run（未写入任何内容）' : '会话归位 · 已执行',
    '',
    ...truncationLines(plan),
    ...actionSection(plan, applied, dryRun, maxItems),
    ...groupSection('失败', failedLines(applied), maxItems),
    ...groupSection('无匹配工作区', plan.noWorkspace.map(noWorkspaceLine), maxItems),
    ...groupSection('cwd 无法校验', plan.invalid.map(invalidLine), maxItems),
    ...tallyLines(plan),
    '',
    footer(plan, dryRun),
  ].join('\n');
}

/**
 * 候选窗口被截断时的显式提示。
 *
 * 会话列表按「最新优先」返回，所以被截断的是更早的会话 —— 报告必须说清楚，
 * 不能因为没看那么多就声称「没有需要归位的会话」。
 * @param {object} plan 计划。
 * @returns {string[]} 提示行；无截断时为空数组。
 */
function truncationLines(plan) {
  const truncated = Number.isFinite(plan.truncated) ? plan.truncated : 0;
  if (truncated <= 0) return [];
  return [
    `⚠ 会话总数超过单次检查上限，还有 ${truncated} 个更早的会话未参与判定。`,
    '  先处理较新的会话（或归档它们）再重试，才能覆盖到更早的那些。',
    '',
  ];
}

/**
 * 把「拖拽落点」的单会话判定折成一条结论。
 *
 * 归属的唯一权威是宿主：浏览器半边没有 `fs.realpath`，它的预筛只是提示。
 * 所以这里把宿主侧的全部失败分支翻译成明确的用户语言，前端不再自己拼文案。
 * @param {object} plan 完整计划。
 * @param {string} sessionId 落点会话。
 * @param {string} [workspaceId] 落点分组的工作区 id。
 * @returns {{status: string, code: string, message: string}} 结论。
 */
export function describeSingle(plan, sessionId, workspaceId) {
  if (plan.total === 0) return single('unknown', 'session-not-found', '找不到这个会话，可能已被删除。');
  const skipped = skippedSingle(plan, sessionId);
  if (skipped !== undefined) return skipped;
  const invalid = plan.invalid.find((entry) => entry.sessionId === sessionId);
  if (invalid !== undefined) return single('rejected', 'cwd-invalid', `未归位：${invalid.reasonText}${suffixPath(invalid.cwd)}`);
  const stray = plan.noWorkspace.find((entry) => entry.sessionId === sessionId);
  if (stray !== undefined) return single('rejected', 'no-workspace', noWorkspaceMessage(stray));
  if (plan.accounted.includes(sessionId)) return single('noop', 'already-accounted', '这个会话已经有归属，无需归位。');
  return singleTarget(plan, sessionId, workspaceId);
}

/**
 * 判定落点分组是否就是该会话该去的那一个。
 * @param {object} plan 完整计划。
 * @param {string} sessionId 落点会话。
 * @param {string} [workspaceId] 落点分组的工作区 id。
 * @returns {{status: string, code: string, message: string}} 结论。
 */
function singleTarget(plan, sessionId, workspaceId) {
  const entry = plan.reattachable.find((candidate) => candidate.sessionId === sessionId);
  if (entry === undefined) return single('unknown', 'session-not-found', '找不到这个会话的归位目标。');
  if (workspaceId === undefined || workspaceId === entry.workspaceId) {
    return single('ready', 'ok', `可归位到「${entry.workspaceTitle}」。`);
  }
  const dropped = plan.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
  if (dropped === undefined) return single('rejected', 'workspace-not-found', '落点的工作区已不存在。');
  return single('rejected', 'workspace-mismatch', mismatchMessage(entry, dropped));
}

/** 跳过类结论。 */
function skippedSingle(plan, sessionId) {
  const pairs = [
    ['live', 'session-live', '这个会话正在运行，跳过。'],
    ['archived', 'session-archived', '这个会话已归档，跳过。'],
    ['subagent', 'session-subagent', '这是子代理会话，跳过。'],
  ];
  for (const [bucket, code, message] of pairs) {
    if (plan.skipped[bucket].includes(sessionId)) return single('rejected', code, message);
  }
  return undefined;
}

/** 无匹配工作区的说明：把「该目录还没有工作区记录」这条常见路径讲清楚。 */
function noWorkspaceMessage(entry) {
  return `未归位：这个会话的 cwd 是 ${entry.canonicalPath}，没有任何工作区记录这个目录。`
    + '先在侧边栏为这个目录创建或选中工作区，再归位。';
}

/** 拖错分组的说明：明确告诉用户该拖到哪里。 */
function mismatchMessage(entry, dropped) {
  return `未归位：这个会话的 cwd 是 ${entry.canonicalPath}，只能归位到「${entry.workspaceTitle}」，`
    + `不能归位到「${dropped.title}」。DSH 要求会话 cwd 与工作区目录完全一致。`;
}

/** 结论构造。 */
function single(status, code, message) {
  return { status, code, message };
}

/** 附加路径说明；路径缺失时不加，避免出现 `（undefined）`。 */
function suffixPath(path) {
  return typeof path === 'string' && path !== '' ? `（${path}）` : '';
}

/** 「将归位 / 已归位」段落。 */
function actionSection(plan, applied, dryRun, maxItems) {
  if (dryRun) return groupSection('可归位', plan.reattachable.map(attachableLine), maxItems);
  const attached = (applied ?? []).filter((result) => result.status === 'attached');
  return groupSection('已归位', attached.map(attachedLine), maxItems);
}

/** 失败条目行。 */
function failedLines(applied) {
  return (applied ?? [])
    .filter((result) => result.status === 'failed')
    .map((result) => `• ${result.sessionId}：${result.message}`);
}

/** 可归位条目行。 */
function attachableLine(entry) {
  return `• ${entry.sessionId} → 「${entry.workspaceTitle}」（${entry.workspacePath}）`;
}

/** 已归位条目行。 */
function attachedLine(result) {
  return `• ${result.sessionId} → 「${result.workspaceTitle}」`;
}

/** 无匹配工作区条目行。 */
function noWorkspaceLine(entry) {
  return `• ${entry.sessionId}：${entry.canonicalPath}`;
}

/** cwd 不合法条目行。 */
function invalidLine(entry) {
  return `• ${entry.sessionId}：${entry.reasonText}${suffixPath(entry.cwd)}`;
}

/**
 * 生成一个带条目上限的段落；没有条目时不产生任何行。
 * @param {string} title 段落标题。
 * @param {readonly string[]} items 已渲染的条目行。
 * @param {number} maxItems 最多列出几条。
 * @returns {string[]} 段落行。
 */
function groupSection(title, items, maxItems) {
  if (items.length === 0) return [];
  const shown = items.slice(0, maxItems);
  const hidden = items.length - shown.length;
  const tail = hidden > 0 ? [`  …另有 ${hidden} 个未列出`] : [];
  return [`${title} ${items.length} 个：`, ...shown, ...tail, ''];
}

/** 跳过统计与「已归属」统计。 */
function tallyLines(plan) {
  const skipped = Object.entries(plan.skipped)
    .filter(([, ids]) => ids.length > 0)
    .map(([bucket, ids]) => `${SKIP_LABELS[bucket]} ${ids.length} 个`);
  const lines = [];
  if (skipped.length > 0) lines.push(`跳过：${skipped.join('、')}`);
  if (plan.accounted.length > 0) lines.push(`已归属、无需动作：${plan.accounted.length} 个`);
  return lines;
}

const SKIP_LABELS = Object.freeze({ archived: '已归档', live: '运行中', subagent: '子代理会话' });

/** 结尾：下一步怎么做，以及为什么会有额外写入。 */
function footer(plan, dryRun) {
  const pending = plan.reattachable.length;
  if (pending === 0 && dryRun) return '没有需要归位的会话。';
  const notes = [];
  if (pending > 0 && dryRun) notes.push('执行：/reattach apply，或把会话直接拖进侧边栏里对应的工作区分组。');
  if (pending > 0) notes.push('归位会先从其余工作区清掉该会话的陈旧归属槽位：DSH 要求一个会话只能被一个工作区记账，残留槽位会导致下次启动校验失败。');
  return notes.join('\n');
}

// 浏览器半边的纯逻辑：不碰 DOM、不碰网络，全部可在 Node 下单测。
//
// 这一层只为三件事负责：把宿主状态端点回的数据解析成可用映射、
// 判断某个分组能不能接收当前拖拽、把宿主返回的结果折成一句提示。
// 任何涉及「归属到底对不对」的判断都不在这里 —— 权威永远在宿主侧。

/** HTTP 路由（与宿主 lib/http.js 的 ROUTE_PATH 必须一致）。 */
export const ROUTE_PATH = '/session-reattach';
/** 状态端点：给出「可归位会话 → 目标工作区」的映射。 */
export const STATE_PATH = `${ROUTE_PATH}/state`;

/** 会话 id 形状：`session-<uuid>` 或裸 `<uuid>`（子代理用裸 uuid）。 */
export const SESSION_ID_PATTERN = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * 判断一个值是否像会话 id。
 * 内置拖拽把 id 写进 `dataTransfer` 的 text/plain，任何文本都可能进来，
 * 所以这里严格按 UUID 形状过滤，避免把用户拖的别的东西当成会话。
 * @param {unknown} value 候选值。
 * @returns {boolean} 像会话 id 时为 true。
 */
export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value.trim());
}

/**
 * 解析状态端点响应。
 * @param {unknown} payload 已解析的 JSON。
 * @returns {{targets: Map<string, object>, titles: string[]} | undefined} 可用状态；形状不对时 undefined。
 */
export function parseState(payload) {
  const body = payload?.ok === true ? payload : undefined;
  if (body === undefined || !Array.isArray(body.sessions) || !Array.isArray(body.workspaces)) return undefined;
  const targets = new Map();
  for (const entry of body.sessions) {
    const target = targetFromEntry(entry);
    if (target !== undefined) targets.set(target.sessionId, target);
  }
  return { targets, titles: body.workspaces.map((workspace) => textOf(workspace?.title)) };
}

/** 单条状态条目 → 目标工作区；形状不对时 undefined。 */
function targetFromEntry(entry) {
  const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId : undefined;
  const workspaceId = typeof entry?.workspaceId === 'string' ? entry.workspaceId : undefined;
  if (sessionId === undefined || workspaceId === undefined) return undefined;
  return { sessionId, workspaceId, workspaceTitle: textOf(entry?.workspaceTitle) };
}

/**
 * 取某个会话的归位目标。
 * @param {object|undefined} state `parseState` 的结果。
 * @param {string|undefined} sessionId 会话 id。
 * @returns {object|undefined} 目标工作区（含 workspaceId / workspaceTitle）。
 */
export function targetOf(state, sessionId) {
  if (state === undefined || typeof sessionId !== 'string') return undefined;
  return state.targets.get(sessionId);
}

/**
 * 判定一次拖拽落点。
 *
 * `allow-unknown` 是刻意的：会话不在可归位集合里（cwd 已失效、无工作区、已归档……）时，
 * 我们不在浏览器端猜原因，而是放行让宿主给出准确解释，再由提示条显示给用户。
 * @param {object|undefined} state 状态。
 * @param {string|undefined} sessionId 被拖的会话。
 * @param {unknown} groupTitle 落点分组的可见标题。
 * @returns {'allow-target' | 'allow-unknown' | 'reject'} 判定结果。
 */
export function decideDrop(state, sessionId, groupTitle) {
  const target = targetOf(state, sessionId);
  if (target === undefined) return 'allow-unknown';
  return sameTitle(target.workspaceTitle, groupTitle) ? 'allow-target' : 'reject';
}

/**
 * 生成 apply 请求体。
 * `dryRun: false` 必须显式给出：宿主默认是 dry-run，绝不会因为少传字段而误写。
 * @param {string} sessionId 会话 id。
 * @param {string|undefined} workspaceId 落点工作区 id。
 * @returns {object} 请求体。
 */
export function applyBody(sessionId, workspaceId) {
  return workspaceId === undefined
    ? { sessionId, dryRun: false }
    : { sessionId, workspaceId, dryRun: false };
}

/**
 * 把宿主响应折成一句提示。
 * @param {unknown} payload 宿主返回的 JSON（形状不对时为 undefined）。
 * @param {string} [fallbackTitle] 已知的目标工作区标题，用于成功文案。
 * @returns {{ok: boolean, text: string}} 提示。
 */
export function toastFor(payload, fallbackTitle) {
  const attached = payload?.applied?.find?.((entry) => entry?.status === 'attached');
  if (attached !== undefined) {
    return { ok: true, text: `已归位到「${textOf(attached.workspaceTitle) || textOf(fallbackTitle)}」。` };
  }
  const single = payload?.single;
  if (typeof single?.message === 'string' && single.message !== '') {
    return { ok: single.status === 'noop', text: single.message };
  }
  const failed = payload?.failed?.find?.((entry) => typeof entry?.message === 'string');
  if (failed !== undefined) return { ok: false, text: failed.message };
  return { ok: false, text: '归位失败：宿主返回了无法识别的结果。' };
}

/** 归一文本：去首尾空白，缺失时为空串。 */
export function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 归一后逐字比较（标题可能带首尾空白）。 */
export function sameTitle(left, right) {
  const a = textOf(left);
  return a !== '' && a === textOf(right);
}

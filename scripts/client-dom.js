// 浏览器半边的 DOM 接线（片段，不是模块！）。
//
// 由 scripts/build-client.mjs 内联进 lib/client.js：拼接后与 lib/client-core.js 处于
// 同一作用域，可以直接调用 core 里的 isSessionId / parseState / decideDrop 等函数。
// 本文件不要写 import / export。
//
// 设计边界：只做「事件代理 + 落点判定 + 结果提示」，不接管内置拖拽。
// 内置侧边栏把会话 id 写进了 dataTransfer 的 text/plain（Rows 的 onDragStart），
// 我们只读不写；同组排序仍然完全由内置实现处理。

/** 允许放置时给分组行加的类名。 */
const HIGHLIGHT_CLASS = 'dsr-reattach-target';
/** 会话行锚点：内置给会话行 role=treeitem 且带 aria-selected。 */
const SESSION_ROW_SELECTOR = '[role="treeitem"][aria-selected]';
/** 工作区分组行锚点：真实工作区行可拖拽（未分组的桶不可拖拽，正好被排除）。 */
const GROUP_ROW_SELECTOR = '[role="treeitem"][aria-expanded][draggable="true"]';
/** 状态缓存有效期：拖拽是连续动作，5 秒内复用同一份状态。 */
const STATE_TTL_MS = 5000;
/** 提示条自动消失时间。 */
const TOAST_TIMEOUT_MS = 6000;

let stateCache;
let pending;
let highlighted;
let toastBox;
let toastTimer;

/** 浏览器半边入口：只装文档级事件代理。 */
function apply() {
  document.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onDrop);
  document.addEventListener('dragend', onDragEnd);
  void refreshState();
}

/** 拖拽开始：认会话行、记会话 id、把「该落在哪个分组」提前高亮出来。 */
function onDragStart(event) {
  if (closestOf(event?.target, SESSION_ROW_SELECTOR) === null) return;
  pending = { sessionId: readSessionId(event) };
  highlightTarget();
  void refreshState().then(highlightTarget, noop);
}

/** 拖拽经过分组行：只有允许落点的分组才 preventDefault（其余显示禁止光标）。 */
function onDragOver(event) {
  if (pending === undefined) return;
  const group = groupRowOf(event?.target);
  if (group === null) return;
  if (decideDrop(stateOf(), pending.sessionId, textOf(group.textContent)) === 'reject') {
    setDropEffect(event, 'none');
    return;
  }
  event.preventDefault();
  setDropEffect(event, 'move');
}

/** 放置：把落点交给宿主判定与执行，结果用提示条说明。 */
function onDrop(event) {
  if (pending === undefined) return;
  const group = groupRowOf(event?.target);
  if (group === null) return;
  const sessionId = pending.sessionId ?? readSessionId(event);
  if (sessionId === undefined) return;
  if (decideDrop(stateOf(), sessionId, textOf(group.textContent)) === 'reject') return;
  event.preventDefault();
  const target = targetOf(stateOf(), sessionId);
  pending = undefined;
  clearHighlight();
  void submit(sessionId, target);
}

/** 拖拽结束（无论成功与否）：清状态与高亮。 */
function onDragEnd() {
  pending = undefined;
  clearHighlight();
}

/**
 * 请求宿主执行归位。
 * @param {string} sessionId 会话 id。
 * @param {object|undefined} target 已知的目标工作区（可能未知，由宿主自行解析）。
 * @returns {Promise<void>} 提示展示完成后 resolve。
 */
async function submit(sessionId, target) {
  try {
    const response = await fetch(ROUTE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(applyBody(sessionId, target?.workspaceId)),
    });
    if (response.status === 401 || response.status === 403) {
      showToast({ ok: false, text: '归位请求被宿主拒收：当前页面未通过认证，请刷新页面后重试。' });
      return;
    }
    const payload = await readJson(response);
    showToast(toastFor(payload, target?.workspaceTitle));
    if (payload?.applied?.length > 0) stateCache = undefined;
  } catch (error) {
    showToast({ ok: false, text: `归位请求失败：${describeError(error)}` });
  }
}

/**
 * 刷新「可归位会话 → 目标工作区」状态（带短 TTL 缓存）。
 * 任何失败都只把状态置为未知：未知时落点一律放行，由宿主给出准确结论。
 * @returns {Promise<object|undefined>} 最新状态。
 */
async function refreshState() {
  const cached = stateCache;
  if (cached !== undefined && Date.now() - cached.at < STATE_TTL_MS) return cached.state;
  try {
    const response = await fetch(STATE_PATH, { headers: { accept: 'application/json' } });
    const state = response.ok ? parseState(await response.json()) : undefined;
    stateCache = { at: Date.now(), state };
  } catch {
    stateCache = { at: Date.now(), state: undefined };
  }
  return stateCache.state;
}

/** 当前状态（可能是 undefined，表示未知）。 */
function stateOf() {
  return stateCache?.state;
}

/** 从拖拽数据里读会话 id；只接受 UUID 形状。 */
function readSessionId(event) {
  const data = event?.dataTransfer;
  if (data === undefined || data === null) return undefined;
  let text;
  try {
    text = data.getData('text/plain');
  } catch {
    return undefined;
  }
  return isSessionId(text) ? text.trim() : undefined;
}

/** 高亮当前拖拽会话该去的那个分组。 */
function highlightTarget() {
  clearHighlight();
  const target = targetOf(stateOf(), pending?.sessionId);
  if (target === undefined) return;
  const group = findGroupByTitle(target.workspaceTitle);
  if (group === null) return;
  ensureStyle();
  group.classList.add(HIGHLIGHT_CLASS);
  highlighted = group;
}

/** 清掉高亮。 */
function clearHighlight() {
  if (highlighted === undefined || highlighted === null) return;
  highlighted.classList.remove(HIGHLIGHT_CLASS);
  highlighted = undefined;
}

/**
 * 按可见标题找分组行。
 *
 * 这是本插件与内置侧边栏之间唯一的结构耦合点：DOM 行不携带工作区 id，
 * 只能靠标题匹配。标题重复时可能高亮/放行到同名的另一个分组 —— 那种情况下
 * 宿主仍会拒绝并给出「只能归位到 X」的提示，所以最坏结果是一句明确报错，不会写错数据。
 * @param {string} title 工作区标题。
 * @returns {object|null} 分组行元素。
 */
function findGroupByTitle(title) {
  for (const row of document.querySelectorAll(GROUP_ROW_SELECTOR)) {
    if (sameTitle(row.textContent, title)) return row;
  }
  return null;
}

/**
 * 从任意后代元素定位所在的分组行：
 * 直接命中分组行，或向上找到第一个包含分组行的祖先（即分组区块）。
 * @param {object|undefined} element 事件目标。
 * @returns {object|null} 分组行元素。
 */
function groupRowOf(element) {
  const direct = closestOf(element, GROUP_ROW_SELECTOR);
  if (direct !== null) return direct;
  let node = element?.parentElement ?? null;
  while (node !== null && node !== document.body) {
    const header = node.querySelector?.(GROUP_ROW_SELECTOR) ?? null;
    if (header !== null) return header;
    node = node.parentElement ?? null;
  }
  return null;
}

/** `closest` 的安全封装。 */
function closestOf(element, selector) {
  const node = element?.closest?.(selector) ?? null;
  return node;
}

/** 设置放置光标；dataTransfer 缺失时静默跳过。 */
function setDropEffect(event, value) {
  if (event?.dataTransfer === undefined || event.dataTransfer === null) return;
  event.dataTransfer.dropEffect = value;
}

/** 解析响应 JSON；解析失败返回 undefined。 */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** 显示提示条。 */
function showToast(result) {
  const box = ensureToast();
  box.textContent = result.text;
  box.className = result.ok ? 'dsr-reattach-toast dsr-reattach-ok' : 'dsr-reattach-toast dsr-reattach-err';
  box.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_TIMEOUT_MS);
}

/** 隐藏提示条。 */
function hideToast() {
  if (toastBox !== undefined) toastBox.style.display = 'none';
}

/** 懒建提示条节点。 */
function ensureToast() {
  ensureStyle();
  if (toastBox === undefined) {
    toastBox = document.createElement('div');
    toastBox.className = 'dsr-reattach-toast';
    toastBox.style.display = 'none';
    document.body.appendChild(toastBox);
  }
  return toastBox;
}

/** 只注入一次样式：高亮虚线与提示条外观都靠它，不污染内置元素的 inline style。 */
function ensureStyle() {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  document.head.appendChild(style);
}

const STYLE_ID = 'dsr-reattach-style';
const STYLE_TEXT = [
  '.dsr-reattach-target{outline:2px dashed var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px;border-radius:6px;}',
  '.dsr-reattach-toast{position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:380px;',
  'padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.5;box-shadow:0 6px 24px rgba(0,0,0,.18);',
  'color:#fff;background:#3b3f46;pointer-events:none;}',
  '.dsr-reattach-toast.dsr-reattach-ok{background:#1f7a45;}',
  '.dsr-reattach-toast.dsr-reattach-err{background:#9b2c2c;}',
].join('');

/** 把任意抛出物折成可读文本。 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 空回调。 */
function noop() {}

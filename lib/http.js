// HTTP 半边：浏览器拖拽落点唯一的入口。
//
// 为什么用 HTTP 路由而不是自研 Remote 服务：DSH 的 typert Remote 对第三方包需要
// 描述符贡献（客户端还要 `ctx.remote.$mount`）才能被调用，而 `ctx.webServer.register`
// 是普通插件就能用的能力，且 `ctx.connection.requestRejection` 提供了与 `/api`
// 完全一致的 Host/Origin 围栏与浏览器认证。少一层生成物、少一层版本耦合。

import { pickSession } from './core/plan.js';
import { summarizeResults } from './core/execute.js';
import { describeSingle, renderPlanReport } from './core/render.js';

/** 路由前缀；`/session-reattach/state` 也挂在它下面。 */
export const ROUTE_PATH = '/session-reattach';
/** 状态端点：给浏览器半边做落点预筛。 */
export const STATE_PATH = `${ROUTE_PATH}/state`;
/** 请求体上限：这里只有几个字段，超过就是异常流量。 */
export const MAX_BODY_BYTES = 64 * 1024;
/** 响应里每个分类最多回多少条，避免会话极多时撑爆载荷。 */
export const MAX_ITEMS = 200;

/**
 * 创建路由处理器。
 *
 * 整个处理过程包在一层错误边界里：宿主服务（信任判定、会话查询）故障时回一个**可诊断**的
 * JSON 500，而不是把异常抛给 webServer 变成空 400（那样调用方只看到 bad request，
 * 排障时无从下手）。错误细节只进宿主日志，不回给调用方。
 * @param {object} deps 依赖。
 * @param {(req: object) => (number|undefined)} deps.reject 请求信任判定，返回 HTTP 状态码表示拒绝。
 * @param {(options: object) => Promise<object>} deps.collectPlan 生成完整计划。
 * @param {(plan: object) => Promise<Array<object>>} deps.execute 执行计划。
 * @param {(error: unknown) => void} [deps.reportFault] 内部故障上报（宿主 logger）。
 * @returns {(req: object, res: object) => Promise<void>} 路由处理器。
 */
export function createRouteHandler(deps) {
  return async function handle(req, res) {
    try {
      await dispatchRequest(req, res, deps);
    } catch (error) {
      reportFault(deps, error);
      sendFault(res);
    }
  };
}

/**
 * 一次请求的分派：先信任判定，再按端点处理。
 * @param {object} req 请求。
 * @param {object} res 响应。
 * @param {object} deps 依赖。
 * @returns {Promise<void>} 处理完成。
 */
async function dispatchRequest(req, res, deps) {
  const rejection = deps.reject(req);
  if (rejection !== undefined) {
    res.writeHead(rejection);
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
    return;
  }
  const pathname = pathnameOf(req);
  if (pathname === STATE_PATH) return await handleState(req, res, deps);
  if (pathname === ROUTE_PATH) return await handleAction(req, res, deps);
  sendJson(res, 404, { ok: false, code: 'not-found', message: `未知端点：${pathname}` });
}

/** 把内部故障交给注入的上报器；未注入时不额外处理（细节绝不回给调用方）。 */
function reportFault(deps, error) {
  if (typeof deps.reportFault === 'function') deps.reportFault(error);
}

/** 回一个不含内部细节的 500；响应已发出时只收尾，不重复写头。 */
function sendFault(res) {
  if (res.writableEnded === true) return;
  if (res.headersSent === true) {
    res.end();
    return;
  }
  sendJson(res, 500, {
    ok: false,
    code: 'internal-error',
    message: '归位请求处理失败（宿主服务异常），未做任何写入。',
  });
}

/** 取请求 pathname；解析失败按不可能匹配的路径处理。 */
function pathnameOf(req) {
  try {
    return new URL(String(req.url), 'http://localhost').pathname;
  } catch {
    return '';
  }
}

/**
 * GET 状态：只回「可归位会话 → 目标工作区」的映射与工作区清单。
 * 浏览器半边靠它决定拖拽时哪个分组才允许放置。
 */
async function handleState(req, res, deps) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET');
  const plan = await deps.collectPlan({});
  sendJson(res, 200, {
    ok: true,
    truncated: plan.truncated ?? 0,
    workspaces: plan.workspaces,
    sessions: plan.reattachable.map((entry) => ({
      sessionId: entry.sessionId,
      workspaceId: entry.workspaceId,
      workspaceTitle: entry.workspaceTitle,
    })),
  });
}

/** POST 动作：dry-run 报告或执行；带 sessionId 时只处理这一个会话。 */
async function handleAction(req, res, deps) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  if (!isJson(req)) return sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type 必须是 application/json' });
  const body = await readJson(req);
  if (!body.ok) return sendJson(res, body.status, { ok: false, code: body.code, message: body.message });
  const request = normalizeRequest(body.value);
  const plan = await deps.collectPlan({ includeSubagents: request.includeSubagents });
  return await respondAction(res, deps, plan, request);
}

/** 按「单会话」或「全量」两种模式生成响应，必要时执行。 */
async function respondAction(res, deps, plan, request) {
  if (request.sessionId === undefined) {
    const applied = request.dryRun ? undefined : await deps.execute(plan);
    return sendJson(res, 200, actionPayload(plan, applied, request.dryRun));
  }
  const single = describeSingle(plan, request.sessionId, request.workspaceId);
  if (request.dryRun || single.status !== 'ready') {
    return sendJson(res, 200, { ok: true, dryRun: request.dryRun, single, applied: [] });
  }
  const applied = await deps.execute(pickSession(plan, request.sessionId));
  return sendJson(res, 200, { ok: true, dryRun: false, single, applied, summary: summarizeResults(applied) });
}

/** 全量模式的响应体。 */
function actionPayload(plan, applied, dryRun) {
  return {
    ok: true,
    dryRun,
    applied: applied ?? [],
    summary: applied === undefined ? undefined : summarizeResults(applied),
    report: renderPlanReport({ plan, applied, dryRun }),
    plan: wirePlan(plan),
  };
}

/** 计划投影：列表截断到上限，其余折成计数。 */
function wirePlan(plan) {
  return {
    total: plan.total,
    malformed: plan.malformed ?? 0,
    truncated: plan.truncated ?? 0,
    workspaces: plan.workspaces,
    reattachable: plan.reattachable.slice(0, MAX_ITEMS),
    noWorkspace: plan.noWorkspace.slice(0, MAX_ITEMS),
    invalid: plan.invalid.slice(0, MAX_ITEMS),
    counts: {
      reattachable: plan.reattachable.length,
      accounted: plan.accounted.length,
      noWorkspace: plan.noWorkspace.length,
      invalid: plan.invalid.length,
      archived: plan.skipped.archived.length,
      live: plan.skipped.live.length,
      subagent: plan.skipped.subagent.length,
    },
  };
}

/** 请求体规范化。dryRun 默认 true：只有显式 `"dryRun": false` 才会写入。 */
function normalizeRequest(value) {
  const source = isObject(value) ? value : {};
  return {
    dryRun: source.dryRun !== false,
    includeSubagents: source.includeSubagents === true,
    sessionId: optionalId(source.sessionId),
    workspaceId: optionalId(source.workspaceId),
  };
}

/** 非空字符串才当 id；其它一律 undefined（宁可不指定，也不要拿 `"[object Object]"` 去查）。 */
function optionalId(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** content-type 是否为 application/json（忽略 charset 等参数）。 */
function isJson(req) {
  const raw = String(req.headers?.['content-type'] ?? '');
  return raw.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

/**
 * 读取并解析 JSON 请求体，带体积上限。
 * @param {object} req 请求对象。
 * @returns {Promise<object>} `{ok: true, value}` 或 `{ok: false, status, code, message}`。
 */
async function readJson(req) {
  const text = await readBody(req);
  if (!text.ok) return text;
  if (text.value.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text.value) };
  } catch {
    return { ok: false, status: 400, code: 'invalid-json', message: '请求体不是合法 JSON' };
  }
}

/**
 * 累积请求体；超限立刻以 413 结束，并把剩余数据**抽干**。
 *
 * 抽干而不是 `req.destroy()`：拆连接会让响应写不出去，调用方只看到 `fetch failed`
 * 而不是 413。抽干（`req.resume()` + 已结算后不再累积）既能保证 413 送达，
 * 也不会把超限数据留在内核缓冲里干扰下一个请求。
 * @param {object} req 请求。
 * @returns {Promise<object>} `{ok: true, value}` 或 `{ok: false, status, code, message}`。
 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settle({ ok: false, status: 413, code: 'payload-too-large', message: '请求体过大' });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle({ ok: true, value: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => settle({ ok: false, status: 400, code: 'body-read-failed', message: '请求体读取失败' }));
  });
}

/** 405。 */
function methodNotAllowed(res, allowed) {
  res.statusCode = 405;
  res.setHeader('allow', allowed);
  sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: `只接受 ${allowed}` });
}

/** JSON 响应（no-store：归属状态是实时事实）。 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** 是否为普通对象。 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

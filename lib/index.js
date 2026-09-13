// dsh-session-reattach 宿主入口。
//
// 职责：把「归位」这一件事暴露成两个入口，二者共用同一套核心与依赖：
//   - HTTP 路由 /session-reattach：浏览器半边拖拽落点时调用；
//   - 斜杠命令 /reattach：手工 dry-run / apply。
//
// 本插件只调用 `Workspace.attachSession` / `Workspace.detachSession` 改归属记录，
// **绝不触碰会话文件**（session.jsonl.zstd 一个字节都不写）。

import { createReattachCommand } from './command.js';
import { executePlan } from './core/execute.js';
import { collectPlan } from './host.js';
import { ROUTE_PATH, createRouteHandler } from './http.js';

export const name = 'session-reattach';

/**
 * 依赖的宿主服务。
 * `connection` 用于复用与 `/api` 同一套请求信任判定（Host/Origin 围栏 + 浏览器认证）；
 * 缺任何一个都不启用本插件（宁可没有功能，也不要开一个无守卫的写入端点）。
 */
export const inject = ['workspaceRegistry', 'sessionQuery', 'webServer', 'commands', 'connection'];

/**
 * 注册路由与命令。
 * @param {object} ctx 宿主上下文。
 */
export function apply(ctx) {
  const deps = createDeps(ctx);
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler: createRouteHandler(deps) }),
    `session-reattach: ${ROUTE_PATH}`,
  );
  ctx.effect(() => ctx.commands.register(createReattachCommand(deps)), 'session-reattach: /reattach');
}

/**
 * 组装两个入口共用的依赖。
 * @param {object} ctx 宿主上下文。
 * @returns {object} `{reject, collectPlan, execute, reportFault}`。
 */
function createDeps(ctx) {
  return {
    reject: (req) => ctx.connection.requestRejection(req),
    collectPlan: (options) => collectPlan(ctx, options),
    execute: (plan) => executePlan(plan, {
      resolve: (workspaceId) => ctx.workspaceRegistry.get(workspaceId),
      workspaces: ctx.workspaceRegistry.list(),
    }),
    reportFault: (error) => ctx.logger.warn(error),
  };
}

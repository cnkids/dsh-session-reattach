// 生成浏览器半边 bundle：lib/client.js。
//
// 为什么要有这一步：内置的客户端模块系统用 `<script src>` 以 classic script 方式加载
// bundle，bundle 必须自己调用 `window.__ModuleLoader__.load({id, factory})`，
// 因此它既不能用 ESM 语法，也不能被 Node 直接 import。
// 为了既保住「纯逻辑可单测」又不产生重复实现，这里把可测的纯逻辑模块
// （lib/client-core.js）与 DOM 接线片段（scripts/client-dom.js）合成一个 classic bundle。
//
// 用法：node scripts/build-client.mjs
// 漂移检查：test/client.test.mjs 会重新合成并与已提交的 lib/client.js 逐字比较，
// 忘记重新生成会让测试失败。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** bundle 的模块 id，必须等于包名（内置模块系统按包名解析）。 */
export const BUNDLE_ID = 'dsh-session-reattach';
/** 纯逻辑来源。 */
export const CORE_PATH = path.join(ROOT, 'lib/client-core.js');
/** DOM 接线片段来源。 */
export const DOM_PATH = path.join(ROOT, 'scripts/client-dom.js');
/** 生成物路径。 */
export const OUT_PATH = path.join(ROOT, 'lib/client.js');

const HEADER = [
  '/* 自动生成，请勿手改。',
  ' * 来源：lib/client-core.js（纯逻辑）+ scripts/client-dom.js（DOM 接线）。',
  ' * 重新生成：node scripts/build-client.mjs',
  ' */',
].join('\n');

/**
 * 去掉 ESM 的 `export ` 前缀，使模块体可以直接内联进 factory 作用域。
 * 只匹配行首，因此 JSDoc 正文里出现的 export 字样不受影响。
 * @param {string} source 模块源码。
 * @returns {string} 去掉导出关键字后的源码。
 */
export function stripExports(source) {
  return source.replaceAll(/^export /gmu, '');
}

/**
 * 合成 bundle 文本。
 * @param {string} core 已去导出关键字的纯逻辑源码。
 * @param {string} dom DOM 接线片段。
 * @returns {string} bundle 文本。
 */
export function compose(core, dom) {
  return [
    HEADER,
    'window.__ModuleLoader__.load({',
    `\tid: '${BUNDLE_ID}',`,
    '\tfactory: () => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    indent(core),
    indent(dom),
    '\t\texports.apply = apply;',
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ].join('\n');
}

/**
 * 读取两个来源并合成 bundle。
 * @returns {Promise<string>} bundle 文本。
 */
export async function buildBundle() {
  const [core, dom] = await Promise.all([
    readFile(CORE_PATH, 'utf8'),
    readFile(DOM_PATH, 'utf8'),
  ]);
  return compose(stripExports(core), dom);
}

/** 统一缩进一层；空行保持为空。 */
function indent(source) {
  return source
    .trimEnd()
    .split('\n')
    .map((line) => (line === '' ? '' : `\t\t${line}`))
    .join('\n');
}

// 直接运行时写盘
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundle = await buildBundle();
  await writeFile(OUT_PATH, bundle, 'utf8');
  process.stdout.write(`已生成 ${path.relative(ROOT, OUT_PATH)}（${Buffer.byteLength(bundle)} 字节）\n`);
}

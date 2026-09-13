// 路径 canon：与 dsh-workspace 的 `realpathNormalize` 保持同一套判定。
//
// 为什么必须用 realpath，而不是像 dsh-palimpsest 的 `normalizeCwd` 那样只去尾部斜杠：
// palimpsest 比对的是「同一来源的字符串」（调用方会话头 vs 候选会话头），只去尾斜杠就够；
// 本插件比对的是「同一个物理目录」（会话 cwd vs 工作区 path），必须把符号链接、`..`、
// 尾斜杠、路径大小写一并归一，否则同一个目录会被判成不匹配。工作区 path 在 DSH 侧
// 建记录时就已是 `fs.realpath` 的结果，所以这里是同 canon 的两端比较。

import { realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

/** cwd 校验失败的原因码 → 人话。 */
export const INVALID_CWD_REASONS = Object.freeze({
  'no-cwd': '会话头没有 cwd，无法校验',
  'not-absolute': 'cwd 不是绝对路径',
  unresolvable: 'cwd 已失效（目录被移动、改名或不可访问）',
  'not-a-directory': 'cwd 指向的不是目录',
});

/**
 * 判断路径在指定平台上是否为完全限定的绝对路径。
 *
 * 与 dsh-workspace 的 `fullyQualifiedWorkspacePath` 同判据：Windows 上还要排除
 * 「只有根符号」的写法（`\foo` 会按当前驱动器解析，不是固定位置）。
 * @param {unknown} value 候选路径。
 * @param {string} platform 平台名，可注入以便测试。
 * @returns {boolean} 是完全限定路径时为 true。
 */
export function isFullyQualified(value, platform = process.platform) {
  if (typeof value !== 'string' || value === '') return false;
  if (platform !== 'win32') return posix.isAbsolute(value);
  const root = win32.parse(value).root;
  return win32.isAbsolute(value) && root !== '\\' && root !== '/';
}

/**
 * 把一个会话头 cwd 规范化成工作区路径的同一套 canon。
 * @param {unknown} cwd 会话头里的 cwd。
 * @param {string} platform 平台名，可注入以便测试。
 * @returns {Promise<{ok: true, path: string} | {ok: false, reason: string}>} 规范化路径或失败原因码。
 */
export async function canonicalDirectory(cwd, platform = process.platform) {
  if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, reason: 'no-cwd' };
  if (!isFullyQualified(cwd, platform)) return { ok: false, reason: 'not-absolute' };
  let resolved;
  try {
    resolved = await realpath(cwd);
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }
  if (!(await isDirectory(resolved))) return { ok: false, reason: 'not-a-directory' };
  return { ok: true, path: resolved };
}

/**
 * 判断路径当前是否存在且是目录；任何 stat 失败都按「不可用」处理。
 * @param {string} path 已规范化的绝对路径。
 * @returns {Promise<boolean>} 是可用目录时为 true。
 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

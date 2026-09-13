// 路径 canon 的回归测试：这里的判定与 dsh-workspace 的 realpathNormalize 必须一致，
// 否则「同一个物理目录」会被判成不匹配，归位就会莫名失败。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalDirectory, isFullyQualified } from '../lib/core/paths.js';

test('isFullyQualified：POSIX 只看绝对路径', () => {
  assert.equal(isFullyQualified('/work', 'darwin'), true);
  assert.equal(isFullyQualified('/work/深/目录', 'linux'), true);
  assert.equal(isFullyQualified('work', 'darwin'), false);
  assert.equal(isFullyQualified('./work', 'darwin'), false);
  assert.equal(isFullyQualified('', 'darwin'), false);
});

test('isFullyQualified：Windows 上排除只有根符号的写法', () => {
  assert.equal(isFullyQualified('C:\\work', 'win32'), true);
  assert.equal(isFullyQualified('\\\\server\\share', 'win32'), true);
  assert.equal(isFullyQualified('\\work', 'win32'), false);
  assert.equal(isFullyQualified('/work', 'win32'), false);
});

test('canonicalDirectory：尾斜杠、`.` 与符号链接归一到同一路径', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'reattach-paths-')));
  const work = path.join(root, 'work');
  await mkdir(path.join(work, 'sub'), { recursive: true });
  const link = path.join(root, 'link-to-work');
  await symlink(work, link, 'dir');

  const expected = { ok: true, path: work };
  assert.deepEqual(await canonicalDirectory(work), expected);
  assert.deepEqual(await canonicalDirectory(`${work}/`), expected);
  assert.deepEqual(await canonicalDirectory(path.join(work, 'sub', '..')), expected);
  assert.deepEqual(await canonicalDirectory(link), expected);
});

test('canonicalDirectory：四类失败各自给出原因码', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'reattach-paths-')));
  const file = path.join(root, 'plain.txt');
  await writeFile(file, 'not a directory');

  assert.equal((await canonicalDirectory(undefined)).reason, 'no-cwd');
  assert.equal((await canonicalDirectory('')).reason, 'no-cwd');
  assert.equal((await canonicalDirectory('   ')).reason, 'no-cwd');
  assert.equal((await canonicalDirectory('relative/dir')).reason, 'not-absolute');
  assert.equal((await canonicalDirectory(path.join(root, 'missing'))).reason, 'unresolvable');
  assert.equal((await canonicalDirectory(file)).reason, 'not-a-directory');
});

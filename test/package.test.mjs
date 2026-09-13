// 包契约测试：这些错误原本只会在「重启 dsh web」时才暴露（插件行没进组装、
// 客户端半边找不到、ESM 入口导错），这里在单测阶段就拦住。

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as hostEntry from '../lib/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

test('package.json 基本字段', () => {
  assert.equal(MANIFEST.name, 'dsh-session-reattach');
  assert.match(MANIFEST.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(MANIFEST.type, 'module');
  assert.equal(MANIFEST.license, 'MIT');
});

test('插件是零运行时依赖的', () => {
  assert.equal(MANIFEST.dependencies, undefined);
  assert.equal(MANIFEST.peerDependencies, undefined);
  assert.equal(MANIFEST.optionalDependencies, undefined);
});

test('bundle patch 声明存在且确实插入本插件行', async () => {
  const patchRel = MANIFEST.dsh?.bundle?.patch;
  assert.equal(typeof patchRel, 'string');
  const patchPath = path.join(ROOT, patchRel);
  await access(patchPath);
  const patch = await readFile(patchPath, 'utf8');
  assert.match(patch, new RegExp(`-\\s*id:\\s*${MANIFEST.name}\\b`, 'u'));
  assert.match(patch, new RegExp(`name:\\s*'${MANIFEST.name}'`, 'u'));
});

test('客户端半边声明齐备：platform、./client 导出、文件存在', async () => {
  assert.equal(MANIFEST.dsh?.client?.platform, 'web');
  const clientRel = MANIFEST.exports?.['./client'];
  assert.equal(typeof clientRel, 'string');
  await access(path.join(ROOT, clientRel));
  const bundle = await readFile(path.join(ROOT, clientRel), 'utf8');
  // 内置模块系统按「包名」解析模块表键
  assert.match(bundle, new RegExp(`id:\\s*'${MANIFEST.name}'`, 'u'));
  assert.match(bundle, /window\.__ModuleLoader__\.load\(/u);
});

test('宿主入口是一份可装载的 cordis 插件', () => {
  assert.equal(MANIFEST.exports?.['.'], './lib/index.js');
  assert.equal(MANIFEST.main, 'lib/index.js');
  assert.equal(typeof hostEntry.apply, 'function');
  assert.equal(hostEntry.name, 'session-reattach');
  assert.ok(Array.isArray(hostEntry.inject));
});

test('发布清单覆盖运行时需要的全部文件', () => {
  const files = MANIFEST.files ?? [];
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'README.en.md']) {
    assert.ok(files.includes(entry), `files 缺少 ${entry}`);
  }
});

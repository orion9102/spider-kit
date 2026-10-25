import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinPlugins, getAllPlugins, findPlugin, isSpiderPlugin } from '../dist/index.js';

test('内置插件恰好是三个，形状合法', () => {
  const names = builtinPlugins().map((p) => p.name).sort();
  assert.deepEqual(names, ['api-json', 'github', 'static-site']);
  for (const p of builtinPlugins()) assert.equal(isSpiderPlugin(p), true);
});

test('isSpiderPlugin 拒绝缺形状的对象', () => {
  assert.equal(isSpiderPlugin(null), false);
  assert.equal(isSpiderPlugin({}), false);
  assert.equal(isSpiderPlugin({ name: 'x', version: 1, build() {}, configSchema: [] }), false);
  assert.equal(isSpiderPlugin({ name: 'x', version: '1', build() {}, configSchema: 'no' }), false);
});

test('getAllPlugins 不存在的目录不抛错', async () => {
  const plugins = await getAllPlugins('tests/__no_such_dir__');
  assert.equal(plugins.length, 3);
});

test('findPlugin 找得到 static-site，找不到不存在的名字', async () => {
  assert.equal((await findPlugin('static-site', 'tests/__no_such_dir__')).name, 'static-site');
  assert.equal(await findPlugin('nope', 'tests/__no_such_dir__'), undefined);
});

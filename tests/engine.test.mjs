import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, validateConfig } from '../dist/index.js';

const fakePlugin = {
  name: 'fake', version: '0.0.1', description: '',
  configSchema: [
    { name: 'query', type: 'string', required: true, description: '关键词' },
    { name: 'limit', type: 'number', default: 50, description: '条数' },
  ],
  async build() { throw new Error('不应被调用'); },
};

test('默认值 <- 文件 <- 命令行，逐层覆盖', () => {
  const cfg = mergeConfig(fakePlugin, { limit: 10 }, { limit: 3, extra: 'x' });
  assert.equal(cfg.limit, 3, '命令行最后覆盖');
  assert.equal(cfg.extra, 'x', '命令行可加新字段');
});

test('文件值优先于默认值', () => {
  const cfg = mergeConfig(fakePlugin, { query: 'a', limit: 10 });
  assert.equal(cfg.limit, 10);
  assert.equal(cfg.query, 'a');
});

test('缺省字段取 schema 默认值', () => {
  const cfg = mergeConfig(fakePlugin, { query: 'a' });
  assert.equal(cfg.limit, 50);
});

test('必填缺失时校验报错，且信息含字段名', () => {
  const errors = validateConfig(fakePlugin, mergeConfig(fakePlugin, {}));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /query/);
});

test('必填齐全时校验通过', () => {
  assert.deepEqual(validateConfig(fakePlugin, mergeConfig(fakePlugin, { query: 'a' })), []);
});

test('枚举字段拒绝列表外的值', () => {
  const plugin = {
    ...fakePlugin,
    configSchema: [{ name: 'mode', type: 'string', required: true, enum: ['search-repos', 'user-repos'], description: '模式' }],
  };
  assert.equal(validateConfig(plugin, { mode: 'search-repos' }).length, 0);
  assert.match(validateConfig(plugin, { mode: 'other' })[0], /mode/);
});

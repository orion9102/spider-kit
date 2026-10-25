import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportDataset } from '../dist/index.js';

test('exportDataset 写出 items.json 与 items.jsonl，条数一致', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spider-kit-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 用一个假 Dataset 对象（exportDataset 只用 getData）
  const rows = [{ a: 1 }, { a: 2, b: 'x' }];
  const fake = { getData: async () => ({ items: rows }) };
  const res = await exportDataset(fake, path.join(dir, 'out'));

  assert.equal(res.count, 2);
  assert.equal(res.jsonPath.endsWith('items.json'), true);
  const json = JSON.parse(await readFile(res.jsonPath, 'utf8'));
  assert.deepEqual(json, rows);
  const jsonl = (await readFile(res.jsonlPath, 'utf8')).trim().split('\n');
  assert.equal(jsonl.length, 2);
  assert.deepEqual(JSON.parse(jsonl[0]), rows[0]);
});

test('空结果也正常导出空数组', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spider-kit-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = { getData: async () => ({ items: [] }) };
  const res = await exportDataset(fake, path.join(dir, 'empty'));
  assert.equal(res.count, 0);
  assert.deepEqual(JSON.parse(await readFile(res.jsonPath, 'utf8')), []);
});

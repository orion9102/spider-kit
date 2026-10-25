import { test } from 'node:test';
import assert from 'node:assert/strict';

// 与 src/plugins/api-json.ts 相同的停止规则：默认空页停，stopOnEmpty=false 翻满 maxPages。
function shouldContinue({ pageParam, page, startPage, maxPages, stopOnEmpty, rowCount }) {
  const lastPage = startPage + (maxPages ?? 1) - 1;
  const stopForEmpty = stopOnEmpty !== false && rowCount === 0;
  return Boolean(pageParam) && page < lastPage && !stopForEmpty;
}

test('默认：当前页有条目时继续翻', () => {
  assert.equal(shouldContinue({ pageParam: '_page', page: 1, startPage: 1, maxPages: 3, rowCount: 10 }), true);
});

test('默认：空页停止（stopOnEmpty 回归测试）', () => {
  assert.equal(shouldContinue({ pageParam: '_page', page: 1, startPage: 1, maxPages: 3, rowCount: 0 }), false);
});

test('stopOnEmpty=false：空页也翻满 maxPages', () => {
  assert.equal(shouldContinue({ pageParam: '_page', page: 1, startPage: 1, maxPages: 3, stopOnEmpty: false, rowCount: 0 }), true);
});

test('到达 maxPages 后不再入队', () => {
  assert.equal(shouldContinue({ pageParam: '_page', page: 3, startPage: 1, maxPages: 3, rowCount: 10 }), false);
});

test('startPage 偏移时 lastPage 随之移动', () => {
  assert.equal(shouldContinue({ pageParam: 'p', page: 5, startPage: 5, maxPages: 2, rowCount: 1 }), true);
  assert.equal(shouldContinue({ pageParam: 'p', page: 6, startPage: 5, maxPages: 2, rowCount: 1 }), false);
});

test('未配置 pageParam 时永不翻页', () => {
  assert.equal(shouldContinue({ page: 1, startPage: 1, maxPages: 9, rowCount: 99 }), false);
});

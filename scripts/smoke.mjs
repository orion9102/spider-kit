// 冒烟测试：本地起一个静态 JSON/HTML 服务，验证三个内置插件的完整链路（不起外网请求）。
// 用法: node scripts/smoke.mjs  （需先 npm run build）
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const pages = {
  '/': '<html><body>' +
    Array.from({ length: 5 }, (_, i) => '<div class="quote"><span class="text">q' + i + '</span><span class="author">a' + i + '</span></div>').join('') +
    '</body></html>',
  '/api': JSON.stringify(Array.from({ length: 4 }, (_, i) => ({ id: i, title: 't' + i }))),
  '/api-empty': JSON.stringify([]),
};

const server = createServer((req, res) => {
  const body = pages[req.url.split('?')[0]];
  if (body === undefined) { res.writeHead(404).end('not found'); return; }
  const type = req.url.startsWith('/api') ? 'application/json' : 'text/html';
  res.writeHead(200, { 'content-type': type }).end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;

const { findPlugin, runPlugin } = await import('../dist/index.js');
let failed = 0;

async function smoke(name, pluginName, config) {
  const plugin = await findPlugin(pluginName, 'scripts/__no_dir__');
  try {
    const result = await runPlugin(plugin, config, { outDir: path.join('output', 'smoke', name) });
    const rows = JSON.parse(await readFile(result.jsonPath, 'utf8'));
    const pass = rows.length === config.__expect;
    console.log((pass ? 'PASS' : 'FAIL') + ' ' + name + ': ' + rows.length + '/' + config.__expect + ' 条, 请求 ' + result.stats.requestsTotal);
    if (!pass) failed++;
  } catch (err) {
    console.log('FAIL ' + name + ': ' + (err && err.message ? err.message : err));
    failed++;
  }
}

// github 插件冒烟：指向本地伪造的 API 不合适（URL 写死 api.github.com），改为只验证配置校验会拦截缺参。
async function smokeGithubValidation() {
  const plugin = await findPlugin('github', 'scripts/__no_dir__');
  try {
    await runPlugin(plugin, { mode: 'search-repos' }, { outDir: 'output/smoke/github-validation' });
    console.log('FAIL github-validation: 缺 query 应当报错');
    failed++;
  } catch (err) {
    const msg = String(err && err.message);
    const pass = msg.includes('query');
    console.log((pass ? 'PASS' : 'FAIL') + ' github-validation: ' + msg.slice(0, 80));
    if (!pass) failed++;
  }
}

await smoke('static-site', 'static-site', {
  startUrls: [base + '/'],
  itemSelector: '.quote',
  fields: { text: '.text', author: '.author' },
  maxRequests: 1,
  __expect: 5,
});
await smoke('api-json-page1', 'api-json', {
  startUrls: [base + '/api'],
  __expect: 4,
});
await smoke('api-json-empty-page-stops', 'api-json', {
  startUrls: [base + '/api-empty'],
  pageParam: '_page',
  maxPages: 3,
  __expect: 0,
});
await smokeGithubValidation();

server.close();
await rm('storage', { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);

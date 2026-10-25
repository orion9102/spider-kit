# spider-kit

插件化通用爬虫框架。请求队列、去重、限速、重试、robots 解析和结果存储复用 [Crawlee](https://crawlee.dev)；插件契约、配置合并、发现机制和结果导出是本项目自己的。

当前版本 **0.1.0**。它能抓静态网页、分页 JSON API 和 GitHub REST 资源。登录态站点、搜索引擎采集和定时任务还没做，见文末路线图。

## 能力范围

**现在能做**

| 能力 | 插件 | 说明 |
| --- | --- | --- |
| 静态网页抽取 | `static-site` | Cheerio 解析 HTML。按 CSS 选择器抽字段，支持 `选择器@属性`。顺着链接自动发现同站页面。 |
| JSON API 分页 | `api-json` | 按点分路径取出条目数组。配置页码参数后自动翻页，空页默认停止。 |
| GitHub REST | `github` | 三种模式：仓库搜索、用户/组织仓库、仓库 Issues。可选 Token，否则匿名。 |
| 外部插件 | `./plugins/*.js` | 放进去即被发现，不用改框架代码。 |
| 库调用 | `src/index.ts` | CLI 之外也可以在代码里 `findPlugin` + `runPlugin`。 |
| 结果导出 | 引擎 | 每次运行写出 `items.json` 和 `items.jsonl`。 |

**现在不能做**

- 不渲染 JavaScript。`static-site` 看到的是服务端返回的 HTML，不是浏览器执行后的 DOM。
- 不登录、不保持 Cookie 会话、不处理验证码。
- 没有 x.com、小红书插件。契约里有 `requiresBrowser`，Playwright 通道还没实现。
- 不是全网搜索引擎。给它的是种子 URL 或 API，不是关键词搜索。
- 没有代理池、UA 轮换、定时任务、增量去重策略和 Web 界面。
- 不绕过付费墙、登录墙或站点明确禁止的抓取。

**实测过的范围**（2026-10-24 / 25，本机）：

- `static-site` 抓 `https://quotes.toscrape.com/`，按 `.quote` 抽出 10 条。
- `api-json` 抓 `https://jsonplaceholder.typicode.com/posts`，`_page` 翻 2 页。
- `github` 搜索 `web crawler` 与 `gcpp`，分别得到仓库列表。

## 工作机制

运行时只有四块：插件、注册表、引擎、导出。

```
spider-kit/
├── src/
│   ├── core/
│   │   ├── plugin.ts     # SpiderPlugin 契约
│   │   ├── registry.ts   # 内置插件 + ./plugins 外部插件
│   │   ├── engine.ts     # 合并配置、校验、运行、导出
│   │   └── storage.ts    # Dataset → items.json / items.jsonl
│   ├── plugins/          # 内置插件，也是写插件的范例
│   │   ├── static-site.ts
│   │   ├── api-json.ts
│   │   └── github.ts
│   ├── cli.ts            # list / info / run
│   └── index.ts          # 可编程入口
├── examples/             # 三份可直接跑的 JSON 配置
├── plugins/              # 外部插件目录，运行时扫描
└── output/               # 运行产物，不入库
```

### 插件契约

一个插件是一个对象，不是一个爬虫类。它只做一件事：根据本次配置 `build()` 出一个 Crawlee crawler。

```ts
interface SpiderPlugin {
  name: string;             // kebab-case，CLI 用这个名字选插件
  version: string;
  description: string;
  requiresBrowser?: boolean;
  configSchema: ConfigField[];
  build(ctx: PluginContext): AnyCrawler | Promise<AnyCrawler>;
}
```

`configSchema` 同时是文档和校验来源。每个字段有 `name`、`type`（`string | number | boolean | array | object`）、`description`，可选 `required` 和 `default`。`info` 命令直接打印这份声明。

`build(ctx)` 拿到的上下文是这次运行的全部依赖，插件不应读 `process.argv` 或自己开全局存储：

| 字段 | 作用 |
| --- | --- |
| `config` | 合并并校验后的配置 |
| `log` | 带 `spider-kit:<插件名>` 前缀的 logger |
| `crawlee` | 原始 Crawlee 命名空间，需要别的 crawler 类时从这里拿 |
| `dataset` | 本次 Dataset。抽到的条目 `pushData` 到这里 |
| `requestQueue` | 本次请求队列。crawler 必须使用它 |
| `addRequests` | 往上面那个队列里加种子或后续请求 |

`build` 的返回值可以是 `CheerioCrawler`、`HttpCrawler` 或 `PlaywrightCrawler`。引擎不关心插件内部怎么解析页面，只调用 `crawler.run()`。

### 注册与发现

内置三个插件写死在 `registry.ts`。外部插件是运行时加载的：

1. 读 `plugins/`（可用 `--external-plugins` 换目录）。目录不存在就当没有外部插件。
2. 只加载 `.js` / `.mjs`。TypeScript 源文件不会被直接 import。
3. `import()` 之后取 `default`，没有则取 `plugin`。
4. `isSpiderPlugin` 做形状检查：必须有字符串 `name`、`version`，函数 `build`，数组 `configSchema`。
5. 单个文件加载失败只打印错误，不中断其他插件。

同名时先注册的内置插件排在前面；`findPlugin` 取数组里第一个同名项。外部插件不要和内置重名。

### 引擎一次运行做的事

`runPlugin()` 的顺序是固定的：

1. **合并配置**：schema 默认值 ← JSON 文件 ← `--set`。文件里没写的字段才填默认值，命令行最后覆盖。
2. **校验**：只检查 `required` 字段是否缺失。类型不强制转换，`--set` 的值会先尝试 `JSON.parse`，失败则保留原字符串。
3. **隔离存储**：用 `插件名_YYYY-MM-DD_HH-MM-SS` 作为 Crawlee `Dataset` 和 `RequestQueue` 的 id，两次运行互不覆盖队列。
4. **构建**：调用 `plugin.build(ctx)`。插件自己把种子放进 `ctx.requestQueue`，并返回已经绑定该队列的 crawler。
5. **执行**：`crawler.run()`。抓取、重试、限速都在 Crawlee 里发生。
6. **导出**：把 Dataset 里的全部条目写成目标目录的 `items.json`（缩进数组）和 `items.jsonl`（一行一条）。默认目录是 `output/<runId>/`，`-o` 可改。

CLI 在调用引擎之前还有一步：除非带了 `--keep-storage`，否则删除 `./storage`。那是 Crawlee 的本地队列和数据集目录。结果已经在 `output/` 里，清掉是为了避免它无限变大。清理发生在运行前，所以本次运行仍会重新创建 `./storage`。

### 三个内置插件各自怎么工作

**static-site** 使用 `CheerioCrawler`。

- 种子是 `startUrls`。
- 每页：若同时给了 `itemSelector` 和 `fields`，就对每个匹配节点抽字段；否则整页只记 `title`。
- 每条记录自动加上 `__pageUrl` 和 `__scrapedAt`。
- 抽完后 `enqueueLinks`：选择器默认 `a[href]`，范围默认是种子 URL 的 origin 加 `/**`。站外链接不会进队列。
- 默认遵守 robots.txt，每分钟最多 60 个请求，并发 5，`maxRequests` 默认 100。

**api-json** 使用 `HttpCrawler`，不跑 HTML 解析。

- 用 `itemPath` 按点号钻进 JSON，例如 `data.items`。路径为空时整个响应就是条目。结果不是数组时包成单元素数组。
- 配了 `pageParam` 才翻页。种子 URL 会被写成起始页，处理完一页后把参数加一入队，直到 `maxPages`。
- `stopOnEmpty` 默认 `true`：当前页抽不出条目就不再入队下一页。设为 `false` 时一直翻到 `maxPages`。
- 请求头可以放在配置的 `headers` 里，加在每个请求上。这个插件默认不查 robots.txt，因为多数 API 根路径没有有意义的 robots 文件。

**github** 也使用 `HttpCrawler`，只访问 `api.github.com`。

- `search-repos`：`/search/repositories`，按 star 降序，需要 `query`。
- `user-repos`：`/users/{user}/repos`，按更新时间排序，需要 `user`。
- `repo-issues`：`/repos/{owner}/{name}/issues?state=all`，需要 `repo`。
- `limit` 默认 50，`perPage` 最大 100。页数由 `ceil(limit / perPage)` 算出，一次把这些 URL 入队，而不是边抓边翻。
- Token 用配置项 `token`，否则读环境变量 `GITHUB_TOKEN`。没有 Token 时匿名搜索限额很低（GitHub 约 10 次/分钟）。Token 只放进请求头，不会写入结果。
- 搜索模式取响应的 `items`；另外两种模式响应本身就是数组。Issues 和仓库的输出字段不同。

## 工作原理

选择 Crawlee 是因为队列、指纹去重、失败重试、robots 和 Dataset 都已经有了，而 x.com / 小红书这类将来要登录和渲染的站点可以换 `PlaywrightCrawler`，不用改引擎。Scrapy 更成熟，但和本机 Node 工具链分开；Colly 更轻，但浏览器和插件生态更小。所以基座用 Crawlee，外壳自己写。

一次抓取在原理上是这个循环：

```
种子 URL
  → RequestQueue（指纹去重，失败可重试）
    → Crawler 取一个请求
      → HTTP 请求（static-site / api-json / github）
        → 插件的 requestHandler 解析并 pushData
        → 可选：发现的新 URL 再入队
  → 队列空，或达到 maxRequestsPerCrawl
→ Dataset.getData()
→ output/<runId>/items.json + items.jsonl
```

几个边界需要知道：

- **去重是请求级的，不是内容级的。** 同一个 URL 不会抓两次。两条内容相同但 URL 不同的记录都会留下。
- **范围控制靠插件，不靠引擎。** `static-site` 用 glob 限制出站链接；另外两个插件根本不发现链接，只请求自己算出的 URL。
- **限速只在 static-site 上有默认值。** API 插件没有 `maxRequestsPerMinute`，请自己把 `maxRequests` / `maxPages` / `limit` 设小。
- **错误策略用 Crawlee 默认值。** 网络失败会重试；配置缺失在 `run()` 之前就抛出；单个外部插件文件损坏不会拖垮 `list`。
- **`requiresBrowser: true` 目前只多打一行警告。** 它不会自动安装或启动 Playwright。

## 工作流程

从一条命令到结果文件：

1. `node dist/cli.js run <name>` 解析参数。
2. `findPlugin` 在内置列表和 `plugins/` 里按 `name` 查找。
3. 若有 `-c`，读取 JSON。文件可以是扁平配置，也可以是 `{ "plugin": "...", "config": { ... } }`，引擎只用 `config`。
4. 每个 `--set key=value` 覆盖同名字段。`value` 像 JSON 就按 JSON 解析，所以数字、布尔和数组要写成 JSON，例如 `--set maxRequests=3`、`--set 'startUrls=["https://example.com"]'`。
5. 删除旧的 `./storage`（除非 `--keep-storage`）。
6. 引擎合并默认值、校验必填项、打开本次 Dataset 和 RequestQueue。
7. 插件 `build()`：创建 crawler，把种子请求放入队列。
8. `crawler.run()` 跑完队列。
9. 导出 `items.json` 与 `items.jsonl`，CLI 打印条数和路径。

配置优先级永远是：**命令行 > 配置文件 > schema 默认值**。必填项三处都没有时，命令直接失败，不会发出请求。

## 运行方式

环境：Node.js **18.17 或更高**，npm。本项目是 ESM（`package.json` 里 `"type": "module"`）。

```bash
cd spider-kit
npm install
npm run build
```

构建只跑 `tsc`，产物在 `dist/`。`dist/`、`node_modules/`、`storage/`、`output/` 都不提交。

### 命令

```bash
# 列出内置和外部插件
node dist/cli.js list

# 看某个插件的配置说明（内容来自 configSchema）
node dist/cli.js info static-site

# 用示例配置跑
node dist/cli.js run static-site -c examples/quotes.json
node dist/cli.js run api-json -c examples/api-posts.json
node dist/cli.js run github -c examples/github-search.json

# 不写配置文件，直接覆盖
node dist/cli.js run github \
  --set mode=search-repos \
  --set 'query=web crawler language:typescript' \
  --set limit=10

# 指定输出目录；保留 Crawlee 的 ./storage 以便排查队列
node dist/cli.js run static-site -c examples/quotes.json -o output/quotes --keep-storage
```

`npm run cli -- list` 等价于 `node dist/cli.js list`。执行 `npm link` 之后可以直接用 `spider-kit` 这个命令名。

GitHub 匿名额度不够时再提供 Token。Token 不要写进配置文件或命令历史：

```bash
GITHUB_TOKEN=*** node dist/cli.js run github --set mode=user-repos --set user=hsutter --set limit=20
```

### 在代码里调用

构建之后：

```js
import { findPlugin, runPlugin } from './dist/index.js';

const plugin = await findPlugin('static-site');
const result = await runPlugin(plugin, {
  startUrls: ['https://quotes.toscrape.com/'],
  itemSelector: '.quote',
  fields: { text: '.text', author: '.author' },
  maxRequests: 2,
});
console.log(result.itemCount, result.jsonPath);
```

`runPlugin` 不负责删除 `./storage`，那是 CLI 的行为。库调用方如果要清理，用导出的 `purgeStorage()`。

### 结果长什么样

`output/<插件名>_<时间戳>/items.json`：

```json
[
  {
    "text": "The world as we have created it is a process of our thinking. It cannot be changed without changing our thinking.",
    "author": "Albert Einstein",
    "firstTag": "change",
    "__pageUrl": "https://quotes.toscrape.com/",
    "__scrapedAt": "2026-10-24T16:08:31.350Z"
  }
]
```

JSONL 是同一批对象，一行一个，方便追加和流式处理。

## 内置插件配置

### static-site

| 字段 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- |
| `startUrls` | 是 | — | 种子 URL 数组 |
| `allowedGlobs` | 否 | 每个种子的 `origin/**` | 允许继续抓的 glob |
| `linkSelector` | 否 | `a[href]` | 发现链接的选择器 |
| `itemSelector` | 否 | 空 | 条目容器。空则整页记一条 |
| `fields` | 否 | 空 | `{ 输出名: "css" }` 或 `"css@attr"` |
| `maxRequests` | 否 | `100` | 最大请求数 |
| `respectRobots` | 否 | `true` | 是否遵守 robots.txt |

`examples/quotes.json`：

```json
{
  "plugin": "static-site",
  "config": {
    "startUrls": ["https://quotes.toscrape.com/"],
    "itemSelector": ".quote",
    "fields": { "text": ".text", "author": ".author", "firstTag": ".tag" },
    "maxRequests": 3
  }
}
```

### api-json

| 字段 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- |
| `startUrls` | 是 | — | API 起点 |
| `headers` | 否 | 空 | 附加请求头 |
| `itemPath` | 否 | 空 | 点分路径，如 `data.items`。空则整个 JSON 当作条目 |
| `pageParam` | 否 | 空 | 页码参数名。空则不翻页 |
| `startPage` | 否 | `1` | 起始页 |
| `maxPages` | 否 | `1` | 最多几页 |
| `stopOnEmpty` | 否 | `true` | 空页停止 |
| `maxRequests` | 否 | `1000` | 请求数安全阀 |

### github

| 字段 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- |
| `mode` | 是 | — | `search-repos`、`user-repos`、`repo-issues` |
| `query` | 搜索模式必填 | — | GitHub 搜索语法，如 `crawler language:typescript` |
| `user` | 用户仓库模式必填 | — | 用户或组织名 |
| `repo` | Issues 模式必填 | — | `owner/name` |
| `token` | 否 | 环境变量 `GITHUB_TOKEN` | 只用于请求头 |
| `limit` | 否 | `50` | 最多保留多少条 |
| `perPage` | 否 | `100` | 每页条数，上限 100 |

## 编写插件

外部插件放在 `plugins/`，文件必须是 `.js` 或 `.mjs`，默认导出插件对象。开发时可以先写 TypeScript，再编译成单个 JS 放进去。

```js
// plugins/hacker-news.js
export default {
  name: 'hacker-news',
  version: '0.1.0',
  description: 'Hacker News 首页标题',
  configSchema: [
    { name: 'pages', type: 'number', description: '抓几页', default: 1 },
  ],
  async build(ctx) {
    const { CheerioCrawler } = ctx.crawlee;
    const pages = ctx.config.pages ?? 1;
    const urls = Array.from({ length: pages }, (_, i) =>
      `https://news.ycombinator.com/news?p=${i + 1}`);
    await ctx.requestQueue.addRequests(urls.map((url) => ({ url })));
    return new CheerioCrawler({
      requestQueue: ctx.requestQueue,
      async requestHandler({ $ }) {
        const items = [];
        $('tr.athing').each((_, el) => {
          items.push({
            id: $(el).attr('id'),
            title: $(el).find('.titleline > a').text(),
            url: $(el).find('.titleline > a').attr('href'),
          });
        });
        if (items.length) await ctx.dataset.pushData(items);
      },
    });
  },
};
```

```bash
node dist/cli.js list
node dist/cli.js run hacker-news --set pages=2
```

插件要遵守的最低约定：

- 使用 `ctx.requestQueue`，不要另开队列，否则引擎看不到请求。
- 结果只 `pushData` 到 `ctx.dataset`，不要自己写输出文件。
- 种子在 `build()` 里入队，或者在 handler 里入队。两边都入同一个队列。
- `configSchema` 里标了 `required` 的字段可以信任它存在；其余字段要自己处理缺省。

登录态或强 JavaScript 站点将来用 `ctx.crawlee.PlaywrightCrawler`，并设置 `requiresBrowser: true`。先安装浏览器：

```bash
npm i playwright && npx playwright install chromium
```

这一步不是当前版本的依赖。

## 合规

- `static-site` 默认遵守 robots.txt，默认每分钟不超过 60 个请求。
- 不要用它访问你没有权利抓取的内容，也不要放高并发压别人的机器。
- GitHub 插件走官方 REST API。有 Token 时遵守该 Token 的权限和 GitHub 速率限制。
- 抓到的数据默认只写本机 `output/`。框架不会上传结果。

## 路线图

目标和分阶段计划在 [ROADMAP.md](ROADMAP.md)。顺序是：先把 v0.1 用测试钉住，再做续爬与失败记录，然后才加浏览器、正文抽取、增量、分布式和专项站点插件。

## License

MIT

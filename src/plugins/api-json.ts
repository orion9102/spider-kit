import { HttpCrawler } from 'crawlee';
import type { SpiderPlugin, PluginContext, ConfigField } from '../core/plugin.js';

const configSchema: ConfigField[] = [
    { name: 'startUrls', type: 'array', required: true, description: 'API 起点 URL 列表' },
    { name: 'headers', type: 'object', description: '附加请求头 { 名称: 值 }' },
    { name: 'itemPath', type: 'string', description: '条目在 JSON 里的取值路径，用 . 分隔（如 data.items；留空则整个响应作为条目）' },
    { name: 'pageParam', type: 'string', description: '分页参数名（如 page / _page）；配置后自动翻页' },
    { name: 'startPage', type: 'number', description: '起始页码', default: 1 },
    { name: 'maxPages', type: 'number', description: '最多抓多少页', default: 1 },
    { name: 'stopOnEmpty', type: 'boolean', description: '某页为空时停止翻页', default: true },
    { name: 'maxRequests', type: 'number', description: '最大请求数（安全阀）', default: 1000 },
];

/** 按点分路径取值 */
function getPath(obj: unknown, pathStr: string): unknown {
    if (!pathStr) return obj;
    return pathStr.split('.').reduce<unknown>((acc, key) => (acc == null ? undefined : (acc as Record<string, unknown>)[key]), obj);
}

const plugin: SpiderPlugin = {
    name: 'api-json',
    version: '0.1.0',
    description: '通用 JSON API 爬虫：按路径提取条目 + 页码参数自动翻页',
    configSchema,
    async build(ctx: PluginContext) {
        const cfg = ctx.config as unknown as {
            startUrls: string[];
            headers?: Record<string, string>;
            itemPath?: string;
            pageParam?: string;
            startPage?: number;
            maxPages?: number;
            stopOnEmpty?: boolean;
            maxRequests?: number;
        };
        const startPage = cfg.startPage ?? 1;

        const crawler = new HttpCrawler({
            requestQueue: ctx.requestQueue,
            maxRequestsPerCrawl: cfg.maxRequests ?? 1000,
            // API 直连场景 robots.txt 通常无意义，默认关闭；如需遵守请自行调整
            respectRobotsTxtFile: false,
            requestHandler: async ({ request, body, json, log }) => {
                const page = (request.userData?.page as number | undefined) ?? startPage;
                log.info(`请求 API ${request.url}`);
                let data: unknown = json;
                if (data === undefined) {
                    const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
                    data = JSON.parse(text);
                }
                const extracted = getPath(data, cfg.itemPath ?? '');
                const items = Array.isArray(extracted) ? extracted : [extracted];
                const rows = items
                    .filter((i) => i != null)
                    .map((i) => ({ __pageUrl: request.url, __scrapedAt: new Date().toISOString(), ...(i as Record<string, unknown>) }));
                if (rows.length) await ctx.dataset.pushData(rows);

                // 页码自动翻页。stopOnEmpty 默认 true：当前页没有条目就不再入队下一页。
                const lastPage = startPage + (cfg.maxPages ?? 1) - 1;
                const stopForEmpty = cfg.stopOnEmpty !== false && rows.length === 0;
                if (cfg.pageParam && page < lastPage && !stopForEmpty) {
                    const next = new URL(request.url);
                    next.searchParams.set(cfg.pageParam, String(page + 1));
                    await ctx.requestQueue.addRequests([{ url: next.href, userData: { page: page + 1 }, ...(cfg.headers ? { headers: cfg.headers } : {}) }]);
                }
            },
        });

        const seeds = cfg.startUrls.map((u) => {
            const url = new URL(u);
            if (cfg.pageParam) url.searchParams.set(cfg.pageParam, String(startPage));
            return { url: url.href, userData: { page: startPage }, ...(cfg.headers ? { headers: cfg.headers } : {}) };
        });
        await ctx.requestQueue.addRequests(seeds);
        return crawler;
    },
};

export default plugin;

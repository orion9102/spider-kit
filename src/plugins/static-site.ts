import { CheerioCrawler } from 'crawlee';
import type { SpiderPlugin, PluginContext, ConfigField } from '../core/plugin.js';

interface StaticSiteConfig {
    startUrls: string[];
    allowedGlobs?: string[];
    linkSelector?: string;
    itemSelector?: string;
    fields?: Record<string, string>;
    maxRequests?: number;
    respectRobots?: boolean;
}

const configSchema: ConfigField[] = [
    { name: 'startUrls', type: 'array', required: true, description: '种子 URL 列表' },
    { name: 'allowedGlobs', type: 'array', description: '抓取范围 glob（默认：种子 URL 的 origin 下所有路径）' },
    { name: 'linkSelector', type: 'string', description: '发现新链接的选择器（默认 a[href]）', default: 'a[href]' },
    { name: 'itemSelector', type: 'string', description: '条目容器选择器；不填则整页记为一条' },
    { name: 'fields', type: 'object', description: '字段映射 { 输出字段: CSS选择器 }，选择器支持 "css@attr" 提取属性' },
    { name: 'maxRequests', type: 'number', description: '最大抓取页数', default: 100 },
    { name: 'respectRobots', type: 'boolean', description: '是否遵守 robots.txt', default: true },
];

/** 从一个元素按 "css@attr" 语法提取字段值（$ 来自 crawler 上下文，宽松类型以兼容 crawlee 内置 cheerio 版本） */
function extractField($: any, scope: any, spec: string): string | null {
    const [css, attr] = String(spec).split('@');
    let node = scope.find(css);
    if (!node.length) node = scope.filter(css);
    if (!node.length) return null;
    const target = node.first();
    return attr ? (target.attr(attr) ?? null) : target.text().trim();
}

const plugin: SpiderPlugin = {
    name: 'static-site',
    version: '0.1.0',
    description: '通用静态网页爬虫：CSS 选择器提取条目 + 自动链接发现/翻页',
    configSchema,
    async build(ctx: PluginContext) {
        const cfg = ctx.config as unknown as StaticSiteConfig;
        const allowedGlobs = cfg.allowedGlobs ?? cfg.startUrls.map((u) => new URL(u).origin + '/**');
        const linkSelector = cfg.linkSelector ?? 'a[href]';
        const itemSelector = cfg.itemSelector;
        const fields = cfg.fields;

        const crawler = new CheerioCrawler({
            requestQueue: ctx.requestQueue,
            maxRequestsPerCrawl: cfg.maxRequests ?? 100,
            respectRobotsTxtFile: cfg.respectRobots ?? true,
            maxRequestsPerMinute: 60, // 礼貌默认限速
            maxConcurrency: 5,
            requestHandler: async ({ request, $, enqueueLinks, log }) => {
                log.info(`抓取页面 ${request.url}`);
                if (itemSelector && fields) {
                    const items: Record<string, unknown>[] = [];
                    $(itemSelector).each((_, el) => {
                        const item: Record<string, unknown> = { __pageUrl: request.url, __scrapedAt: new Date().toISOString() };
                        for (const [name, spec] of Object.entries(fields)) {
                            item[name] = extractField($, $(el), spec);
                        }
                        items.push(item);
                    });
                    if (items.length) await ctx.dataset.pushData(items);
                } else {
                    await ctx.dataset.pushData({
                        __pageUrl: request.url,
                        __scrapedAt: new Date().toISOString(),
                        title: $('title').text().trim(),
                    });
                }
                await enqueueLinks({ selector: linkSelector, globs: allowedGlobs });
            },
        });
        await ctx.addRequests(cfg.startUrls);
        return crawler;
    },
};

export default plugin;

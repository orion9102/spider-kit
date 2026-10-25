import { HttpCrawler } from 'crawlee';
import type { SpiderPlugin, PluginContext, ConfigField } from '../core/plugin.js';

type GithubMode = 'search-repos' | 'user-repos' | 'repo-issues';

const configSchema: ConfigField[] = [
    { name: 'mode', type: 'string', required: true, description: '模式: search-repos | user-repos | repo-issues' },
    { name: 'query', type: 'string', description: '[search-repos] 搜索关键词（支持 GitHub qualifier，如 "crawler language:typescript"）' },
    { name: 'user', type: 'string', description: '[user-repos] 用户名/组织名' },
    { name: 'repo', type: 'string', description: '[repo-issues] 仓库 "owner/name"' },
    { name: 'token', type: 'string', description: 'GitHub Token（可选；不填则读环境变量 GITHUB_TOKEN，匿名限速更低）' },
    { name: 'limit', type: 'number', description: '最多取多少条', default: 50 },
    { name: 'perPage', type: 'number', description: '每页条数（GitHub 上限 100）', default: 100 },
];

function buildApiUrls(mode: GithubMode, query?: string, user?: string, repo?: string, perPage = 100, pages = 1): string[] {
    const urls: string[] = [];
    for (let page = 1; page <= pages; page++) {
        if (mode === 'search-repos') {
            urls.push(`https://api.github.com/search/repositories?q=${encodeURIComponent(query ?? '')}&sort=stars&order=desc&per_page=${perPage}&page=${page}`);
        } else if (mode === 'user-repos') {
            urls.push(`https://api.github.com/users/${user}/repos?sort=updated&per_page=${perPage}&page=${page}`);
        } else {
            urls.push(`https://api.github.com/repos/${repo}/issues?state=all&sort=updated&per_page=${perPage}&page=${page}`);
        }
    }
    return urls;
}

const plugin: SpiderPlugin = {
    name: 'github',
    version: '0.1.0',
    description: 'GitHub 专项爬虫：仓库搜索 / 用户仓库 / 仓库 issues（REST API）',
    configSchema,
    async build(ctx: PluginContext) {
        const cfg = ctx.config as unknown as { mode: GithubMode; query?: string; user?: string; repo?: string; token?: string; limit?: number; perPage?: number };
        if (cfg.mode === 'search-repos' && !cfg.query) throw new Error('mode=search-repos 需要 --set query=<关键词>');
        if (cfg.mode === 'user-repos' && !cfg.user) throw new Error('mode=user-repos 需要 --set user=<用户名>');
        if (cfg.mode === 'repo-issues' && !cfg.repo) throw new Error('mode=repo-issues 需要 --set repo=owner/name');

        const token = cfg.token || process.env.GITHUB_TOKEN;
        const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'spider-kit' };
        if (token) headers.Authorization = `Bearer ${token}`;

        const perPage = Math.min(Math.max(cfg.perPage ?? 100, 1), 100);
        const limit = cfg.limit ?? 50;
        const pages = Math.max(1, Math.ceil(limit / perPage));
        const urls = buildApiUrls(cfg.mode, cfg.query, cfg.user, cfg.repo, perPage, pages);
        let pushed = 0;

        const crawler = new HttpCrawler({
            requestQueue: ctx.requestQueue,
            maxRequestsPerCrawl: pages,
            // GitHub 官方 REST API 属于授权访问通道，robots.txt 不适用
            respectRobotsTxtFile: false,
            requestHandler: async ({ request, json, body, log }) => {
                log.info(`请求 GitHub API ${request.url}`);
                let data: unknown = json;
                if (data === undefined) {
                    const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
                    data = JSON.parse(text);
                }
                const list = cfg.mode === 'search-repos' ? (data as { items?: unknown[] }).items : (data as unknown[]);
                if (!Array.isArray(list)) return;
                const remain = limit - pushed;
                if (remain <= 0) return;
                const batch = list.slice(0, remain);
                pushed += batch.length;
                const rows = batch.map((item) => {
                    const it = item as Record<string, any>;
                    const base = { __pageUrl: request.url, __scrapedAt: new Date().toISOString() };
                    if (cfg.mode === 'repo-issues') {
                        return { id: it.id, number: it.number, title: it.title, state: it.state, user: it.user?.login, created_at: it.created_at, updated_at: it.updated_at, url: it.html_url, ...base };
                    }
                    return { id: it.id, full_name: it.full_name, description: it.description, stars: it.stargazers_count, forks: it.forks_count, language: it.language, url: it.html_url, pushed_at: it.pushed_at, ...base };
                });
                await ctx.dataset.pushData(rows);
            },
        });
        await ctx.requestQueue.addRequests(urls.map((url) => ({ url, headers })));
        return crawler;
    },
};

export default plugin;

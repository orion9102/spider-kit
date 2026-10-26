/** spider-kit Web 界面：下任务、看过程、看结果。零依赖，监听 127.0.0.1。
 *
 * API:
 *   GET  /                    页面
 *   GET  /docs                使用文档
 *   GET  /api/plugins         插件列表与配置项
 *   POST /api/runs            发起运行 { plugin, config }
 *   GET  /api/runs            运行列表（含进行中）
 *   GET  /api/runs/:id        单次运行详情（日志环形缓冲）
 *   GET  /api/results/:id     运行结果条目（最多前 500 条）
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllPlugins, findPlugin } from './core/registry.js';
import { runPlugin } from './core/engine.js';
import { runs } from './core/runs.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function json(res: ServerResponse, code: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        return undefined;
    }
}

/** 发起一次运行（不 await 完成，注册表负责跟踪） */
function launchRun(pluginName: string, config: Record<string, unknown>, outDir?: string): string | { error: string } {
    void (async () => {
        try {
            const plugin = await findPlugin(pluginName);
            if (!plugin) throw new Error(`未找到插件 "${pluginName}"`);
            // 注意：常驻进程不能整体清 storage——Crawlee 内存句柄仍指向那些文件，
            // 删掉后下一次运行会报 SDK_SESSION_POOL_STATE.json 丢失。
            // 隔离由 runId 唯一性保证（时间戳+pid+随机后缀），无需清理。
            await runPlugin(plugin, config, outDir ? { outDir } : {});
        } catch (err) {
            // 注册表之外的失败（如 purgeStorage 抛错）也要留痕：打印到容器日志
            console.error('[launchRun]', err instanceof Error ? err.stack ?? err.message : String(err));
        }
    })();
    return 'accepted';
}

export function startWebServer(port = Number(process.env.PORT ?? 3210)): Promise<{ port: number; close: () => void }> {
    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const parts = url.pathname.split('/').filter(Boolean);

        try {
            if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/docs' || url.pathname === '/docs.html')) {
                const file = url.pathname === '/' ? 'index.html' : 'docs.html';
                const html = await readFile(path.join(ROOT, 'web', file), 'utf8');
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
                return;
            }
            if (req.method === 'GET' && url.pathname === '/api/plugins') {
                const plugins = await getAllPlugins();
                json(res, 200, plugins.map((p) => ({
                    name: p.name,
                    version: p.version,
                    description: p.description,
                    requiresBrowser: p.requiresBrowser ?? false,
                    fields: p.configSchema,
                })));
                return;
            }
            if (req.method === 'POST' && url.pathname === '/api/runs') {
                const body = (await readBody(req)) as { plugin?: string; config?: Record<string, unknown>; outDir?: string } | undefined;
                if (!body || typeof body.plugin !== 'string') { json(res, 400, { error: '需要 { plugin, config }' }); return; }
                const plugin = await findPlugin(body.plugin);
                if (!plugin) { json(res, 404, { error: `未找到插件 "${body.plugin}"` }); return; }
                launchRun(body.plugin, body.config ?? {}, body.outDir);
                json(res, 202, { status: 'accepted' });
                return;
            }
            if (req.method === 'GET' && url.pathname === '/api/runs') {
                json(res, 200, runs.list().map((r) => ({ ...r, lines: r.lines.length })));
                return;
            }
            if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts[2]) {
                const rec = runs.get(parts[2]);
                if (!rec) { json(res, 404, { error: 'run not found' }); return; }
                json(res, 200, rec);
                return;
            }
            if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'results' && parts[2]) {
                const rec = runs.get(parts[2]);
                if (!rec || !rec.jsonPath) { json(res, 404, { error: '结果尚未就绪' }); return; }
                try {
                    const items = JSON.parse(await readFile(rec.jsonPath, 'utf8')) as unknown[];
                    json(res, 200, { total: items.length, items: items.slice(0, 500) });
                } catch {
                    json(res, 500, { error: '读取结果失败' });
                }
                return;
            }
            json(res, 404, { error: 'not found' });
        } catch (err) {
            json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    });

    // HOST 默认 127.0.0.1（本机安全）；容器部署时设 HOST=0.0.0.0 才能被端口映射
    const host = process.env.HOST ?? '127.0.0.1';
    return new Promise((resolve) => {
        server.listen(port, host, () => {
            resolve({ port: (server.address() as { port: number }).port, close: () => server.close() });
        });
    });
}

// 直接运行: node dist/web.js [port]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = process.argv[2] ? Number(process.argv[2]) : undefined;
    startWebServer(port).then(({ port: actual }) => {
        console.log(`spider-kit Web 界面: http://${process.env.HOST ?? '127.0.0.1'}:${actual}`);
    });
}

import * as crawlee from 'crawlee';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SpiderPlugin, SpiderConfig, PluginContext, SpiderLogger } from './plugin.js';
import { runs } from './runs.js';
import { exportDataset } from './storage.js';

export interface RunOptions {
    /** CLI 覆盖项，最后应用 */
    overrides?: SpiderConfig;
    /** 结果输出目录（默认 output/<插件名>_<时间戳>/） */
    outDir?: string;
}

/** 合并配置：schema 默认值 <- 配置文件 <- CLI 覆盖 */
export function mergeConfig(plugin: SpiderPlugin, fileConfig: SpiderConfig = {}, overrides: SpiderConfig = {}): SpiderConfig {
    const merged: SpiderConfig = { ...fileConfig };
    for (const field of plugin.configSchema) {
        if (merged[field.name] === undefined && field.default !== undefined) {
            merged[field.name] = field.default;
        }
    }
    return { ...merged, ...overrides };
}

/** 轻量校验：必填项检查 */
export function validateConfig(plugin: SpiderPlugin, config: SpiderConfig): string[] {
    const errors: string[] = [];
    for (const field of plugin.configSchema) {
        if (field.required && (config[field.name] === undefined || config[field.name] === null)) {
            errors.push(`缺少必填配置 "${field.name}" (${field.type}) — ${field.description}`);
        }
    }
    return errors;
}

/** 清理内部存储目录（结果已导出到 output/，防止 ./storage 无限增长）。
 *  只清空内容而不删除目录本身：容器部署时 ./storage 常是挂载卷，运行中无法 rmdir。 */
export async function purgeStorage(): Promise<void> {
    const dir = './storage';
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        await rm(path.join(dir, entry.name), { recursive: true, force: true });
    }
}

export interface RunStats {
    requestsTotal: number;
    requestsFailed: number;
    retryCount: number;
    durationMs: number;
}

export interface RunResult {
    plugin: string;
    itemCount: number;
    jsonPath: string;
    jsonlPath: string;
    stats: RunStats;
}

/** 运行插件：build -> run -> 导出结果 */
export async function runPlugin(plugin: SpiderPlugin, fileConfig: SpiderConfig = {}, opts: RunOptions = {}): Promise<RunResult> {
    const config = mergeConfig(plugin, fileConfig, opts.overrides ?? {});
    const errors = validateConfig(plugin, config);
    if (errors.length) throw new Error(`[配置错误] ${errors.join('; ')}`);
    const runStartedAt = new Date().toISOString();

    // 每次运行独立的 dataset/requestQueue，互不污染。
    // 时间戳只精确到秒，同一秒内的多次运行会共享存储；加 pid 和随机后缀保证唯一。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const suffix = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const runId = `${plugin.name}_${stamp}_${suffix}`;
    const dataset = await crawlee.Dataset.open(runId);
    const requestQueue = await crawlee.RequestQueue.open(runId);
    const record = runs.start(runId, plugin.name);
    // tee 日志：插件经 ctx.log 打的每行进入运行记录（供 Web 看过程），同时照常输出到控制台
    const tee = (level: 'info' | 'warning' | 'error' | 'debug') => (message: string) => {
        runs.log(record, level, message);
        crawlee.log[level](`[${plugin.name}] ${message}`);
    };
    const runLog: SpiderLogger = { info: tee('info'), warning: tee('warning'), error: tee('error'), debug: tee('debug') };
    const ctx: PluginContext = {
        config,
        log: runLog,
        crawlee,
        dataset,
        requestQueue,
        addRequests: async (requests) => {
            await requestQueue.addRequests(requests);
        },
    };

    if (plugin.requiresBrowser) {
        crawlee.log.warning(`插件 "${plugin.name}" 需要浏览器环境。若未安装: npm i playwright && npx playwright install chromium`);
    }

    // Crawlee 内部日志（抓取页面、重试等）也进入运行记录，Web 界面可见。
    // 保存原函数，运行结束（含失败）后恢复，避免补丁泄漏到后续运行。
    const crawleeLevels = ['info', 'warning', 'error', 'debug'] as const;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const origLog = {} as Record<string, any>;
    for (const lv of crawleeLevels) origLog[lv] = crawlee.log[lv].bind(crawlee.log);
    for (const lv of crawleeLevels) {
        const orig = origLog[lv];
        crawlee.log[lv] = ((level: typeof lv) => (msg: string, data?: unknown) => {
            runs.log(record, level, String(msg));
            orig(msg, data);
        })(lv) as any;
    }
    let startedAt = 0;
    let summary: unknown;
    try {
        const crawler = await plugin.build(ctx);
        startedAt = Date.now();
        summary = await crawler.run();

    // Crawlee run() 返回 finalStatistics；字段可能因版本而异，缺失时置 0
    const fsStat = (summary ?? {}) as unknown as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const stats: RunStats = {
        requestsTotal: num(fsStat.requestsTotal),
        requestsFailed: num(fsStat.requestsFailed),
        retryCount: num(fsStat.retryCount),
        durationMs: Date.now() - startedAt,
    };

    const outDir = opts.outDir ?? path.join('output', runId);
    const res = await exportDataset(dataset, outDir);

    // 运行清单：供 Web 界面与外部工具回读；token 等敏感字段脱敏
    const manifest = {
        plugin: plugin.name,
        pluginVersion: plugin.version,
        runId,
        startedAt: runStartedAt,
        finishedAt: new Date().toISOString(),
        stats,
        itemCount: res.count,
        config: { ...config, token: config.token !== undefined ? '***' : undefined },
        jsonPath: res.jsonPath,
        jsonlPath: res.jsonlPath,
    };
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    crawlee.log.info(
        '统计: 请求 ' + stats.requestsTotal + ' (失败 ' + stats.requestsFailed + ', 重试 ' + stats.retryCount + '), 条目 ' + res.count + ', 耗时 ' + (stats.durationMs / 1000).toFixed(1) + 's',
    );
        runs.finish(runId, { itemCount: res.count, stats, jsonPath: res.jsonPath, jsonlPath: res.jsonlPath });
        return { plugin: plugin.name, itemCount: res.count, jsonPath: res.jsonPath, jsonlPath: res.jsonlPath, stats };
    } catch (err) {
        runs.fail(runId, err instanceof Error ? err.message : String(err));
        throw err;
    } finally {
        for (const lv of crawleeLevels) crawlee.log[lv] = origLog[lv];
    }
}

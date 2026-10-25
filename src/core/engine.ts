import * as crawlee from 'crawlee';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { SpiderPlugin, SpiderConfig, PluginContext } from './plugin.js';
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

/** 清理内部存储目录（结果已导出到 output/，防止 ./storage 无限增长） */
export async function purgeStorage(): Promise<void> {
    await rm('./storage', { recursive: true, force: true });
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

    // 每次运行独立的 dataset/requestQueue，互不污染。
    // 时间戳只精确到秒，同一秒内的多次运行会共享存储；加 pid 和随机后缀保证唯一。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const suffix = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const runId = `${plugin.name}_${stamp}_${suffix}`;
    const dataset = await crawlee.Dataset.open(runId);
    const requestQueue = await crawlee.RequestQueue.open(runId);
    const ctx: PluginContext = {
        config,
        log: crawlee.log.child({ prefix: `spider-kit:${plugin.name}` }),
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

    const crawler = await plugin.build(ctx);
    const startedAt = Date.now();
    const summary = await crawler.run();

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
    crawlee.log.info(
        '统计: 请求 ' + stats.requestsTotal + ' (失败 ' + stats.requestsFailed + ', 重试 ' + stats.retryCount + '), 条目 ' + res.count + ', 耗时 ' + (stats.durationMs / 1000).toFixed(1) + 's',
    );
    return { plugin: plugin.name, itemCount: res.count, jsonPath: res.jsonPath, jsonlPath: res.jsonlPath, stats };
}

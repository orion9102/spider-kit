#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { runPlugin, purgeStorage } from './core/engine.js';
import { getAllPlugins, findPlugin } from './core/registry.js';

const program = new Command();

program
    .name('spider-kit')
    .description('插件化通用爬虫框架（基于 Crawlee）')
    .version('0.1.0');

program
    .command('list')
    .description('列出所有可用插件（内置 + ./plugins 外部插件）')
    .option('--external-plugins <dir>', '外部插件目录', 'plugins')
    .action(async (opts: { externalPlugins: string }) => {
        const plugins = await getAllPlugins(opts.externalPlugins);
        console.log(`共 ${plugins.length} 个插件:`);
        for (const p of plugins) {
            console.log(`  ${p.name}@${p.version}${p.requiresBrowser ? ' [需浏览器]' : ''} — ${p.description}`);
        }
    });

program
    .command('info <name>')
    .description('查看某插件的配置项说明')
    .option('--external-plugins <dir>', '外部插件目录', 'plugins')
    .action(async (name: string, opts: { externalPlugins: string }) => {
        const plugin = await findPlugin(name, opts.externalPlugins);
        if (!plugin) {
            console.error(`未找到插件 "${name}"，用 spider-kit list 查看`);
            process.exitCode = 1;
            return;
        }
        console.log(`${plugin.name}@${plugin.version} — ${plugin.description}`);
        console.log('配置项:');
        for (const f of plugin.configSchema) {
            const req = f.required ? '必填' : '可选';
            const def = f.default !== undefined ? `, 默认 ${JSON.stringify(f.default)}` : '';
            const choices = f.enum?.length
                ? `, 枚举 ${f.enum.map((item) => JSON.stringify(item)).join(' | ')}`
                : f.suggestions?.length
                    ? `, 建议 ${f.suggestions.map((item) => JSON.stringify(item)).join(' | ')}`
                    : '';
            console.log(`  ${f.name}: <${f.type}> [${req}${def}${choices}] ${f.description}`);
        }
    });

function parseValue(s: string): unknown {
    try {
        return JSON.parse(s);
    } catch {
        return s;
    }
}

function collectKv(value: string, previous: Record<string, unknown>): Record<string, unknown> {
    const eq = value.indexOf('=');
    if (eq <= 0) {
        console.error(`--set 参数格式应为 key=value，收到: "${value}"`);
        process.exit(1);
    }
    previous[value.slice(0, eq)] = parseValue(value.slice(eq + 1));
    return previous;
}

program
    .command('run <name>')
    .description('运行一个插件')
    .option('-c, --config <path>', 'JSON 配置文件（flat 配置对象，或 { "plugin": ..., "config": {...} } 包装格式）')
    .option('-s, --set <kv...>', '命令行覆盖配置，如 --set query=crawler --set limit=10（值会尝试按 JSON 解析）', collectKv, {} as Record<string, unknown>)
    .option('-o, --out <dir>', '结果输出目录（默认 output/<插件名>_<时间戳>/）')
    .option('--external-plugins <dir>', '外部插件目录', 'plugins')
    .option('--keep-storage', '保留 ./storage 内部状态（默认每次运行前清理）')
    .action(async (name: string, opts: { config?: string; set: Record<string, unknown>; out?: string; externalPlugins: string; keepStorage?: boolean }) => {
        const plugin = await findPlugin(name, opts.externalPlugins);
        if (!plugin) throw new Error(`未找到插件 "${name}"，用 spider-kit list 查看`);
        let fileConfig: Record<string, unknown> = {};
        if (opts.config) {
            const raw = JSON.parse(readFileSync(opts.config, 'utf8')) as Record<string, unknown>;
            fileConfig = (raw.config && typeof raw.config === 'object' ? raw.config : raw) as Record<string, unknown>;
        }
        if (!opts.keepStorage) await purgeStorage();
        const result = await runPlugin(plugin, fileConfig, { overrides: opts.set, outDir: opts.out });
        console.log(`✔ 完成: ${result.plugin} 共 ${result.itemCount} 条结果`);
        console.log(`  JSON : ${result.jsonPath}`);
        console.log(`  JSONL: ${result.jsonlPath}`);
        const s = result.stats;
        console.log(`  统计 : 请求 ${s.requestsTotal} (失败 ${s.requestsFailed}, 重试 ${s.retryCount}), 耗时 ${(s.durationMs / 1000).toFixed(1)}s`);
    });

program.parseAsync().catch((err: Error) => {
    console.error(err?.message ?? err);
    process.exitCode = 1;
});

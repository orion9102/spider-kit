import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { SpiderPlugin } from './plugin.js';
import staticSitePlugin from '../plugins/static-site.js';
import apiJsonPlugin from '../plugins/api-json.js';
import githubPlugin from '../plugins/github.js';

const BUILTINS: SpiderPlugin[] = [staticSitePlugin, apiJsonPlugin, githubPlugin];

/** 粗略判断一个对象是否符合 SpiderPlugin 形状 */
export function isSpiderPlugin(value: unknown): value is SpiderPlugin {
    if (!value || typeof value !== 'object') return false;
    const p = value as Record<string, unknown>;
    return typeof p.name === 'string' && typeof p.version === 'string' && typeof p.build === 'function' && Array.isArray(p.configSchema);
}

/** 从目录加载外部插件（default export 或 mod.plugin） */
export async function loadExternalPlugins(dir: string): Promise<SpiderPlugin[]> {
    let entries: string[] = [];
    try {
        entries = await readdir(dir);
    } catch {
        return []; // 目录不存在则忽略
    }
    const plugins: SpiderPlugin[] = [];
    for (const entry of entries.filter((e) => e.endsWith('.js') || e.endsWith('.mjs'))) {
        try {
            const mod = (await import(pathToFileURL(path.join(process.cwd(), dir, entry)).href)) as Record<string, unknown>;
            const candidate = (mod.default ?? mod.plugin) as unknown;
            if (isSpiderPlugin(candidate)) plugins.push(candidate);
        } catch (err) {
            console.error(`加载外部插件失败 ${entry}:`, err instanceof Error ? err.message : err);
        }
    }
    return plugins;
}

export function builtinPlugins(): SpiderPlugin[] {
    return [...BUILTINS];
}

export async function getAllPlugins(externalDir = 'plugins'): Promise<SpiderPlugin[]> {
    return [...BUILTINS, ...(await loadExternalPlugins(externalDir))];
}

export async function findPlugin(name: string, externalDir = 'plugins'): Promise<SpiderPlugin | undefined> {
    return (await getAllPlugins(externalDir)).find((p) => p.name === name);
}

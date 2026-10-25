/**
 * SpiderPlugin 契约 —— 所有爬虫插件（内置或外部）都实现这个接口。
 *
 * 插件只负责一件事：根据配置 build() 出一个 Crawlee crawler。
 * 引擎负责：配置合并/校验、运行 crawler、导出结果。
 */
import type { CheerioCrawler, HttpCrawler, PlaywrightCrawler, Dataset, RequestQueue } from 'crawlee';

/** 配置字段的声明式描述，用于 CLI help 与轻量校验 */
export interface ConfigField {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    description: string;
    required?: boolean;
    default?: unknown;
}

export type SpiderConfig = Record<string, unknown>;

/** 插件可基于的任意 Crawlee crawler */
export type AnyCrawler = CheerioCrawler | HttpCrawler<any> | PlaywrightCrawler;

/** 轻量 logger 形状 */
export type SpiderLogger = Pick<typeof import('crawlee').log, 'info' | 'warning' | 'error' | 'debug'>;

/** 引擎交给 build() 的上下文；插件不要直接碰 process.argv / 全局状态 */
export interface PluginContext {
    /** 合并后的最终配置（默认值 <- 配置文件 <- CLI 覆盖） */
    config: SpiderConfig;
    /** 带插件名前缀的 logger */
    log: SpiderLogger;
    /** 原始 crawlee 命名空间，插件可取用其中任何类 */
    crawlee: typeof import('crawlee');
    /** 本次运行的数据集（结果都 push 到这里，运行结束后导出） */
    dataset: Dataset;
    /** 本次运行的请求队列（crawler 必须使用它，引擎才能共享请求） */
    requestQueue: RequestQueue;
    /** 便捷方法：把一批请求加入请求队列 */
    addRequests(requests: Parameters<RequestQueue['addRequests']>[0]): Promise<void>;
}

export interface SpiderPlugin {
    /** 唯一 id，kebab-case，CLI 用它选择插件 */
    name: string;
    version: string;
    description: string;
    /** true = 需要真实浏览器（需安装 playwright） */
    requiresBrowser?: boolean;
    /** 声明式配置文档 + 校验来源 */
    configSchema: ConfigField[];
    /**
     * 构造一个可直接 run 的 crawler。
     * 注意：请把 ctx.requestQueue 传给 crawler，并把种子请求加入该队列。
     */
    build(ctx: PluginContext): AnyCrawler | Promise<AnyCrawler>;
}

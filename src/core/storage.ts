import type { Dataset } from 'crawlee';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ExportResult {
    dir: string;
    jsonPath: string;
    jsonlPath: string;
    count: number;
}

/** 把 Crawlee Dataset 导出到 outDir：items.json + items.jsonl */
export async function exportDataset(dataset: Dataset, outDir: string): Promise<ExportResult> {
    const { items } = await dataset.getData();
    await mkdir(outDir, { recursive: true });
    const jsonPath = path.join(outDir, 'items.json');
    const jsonlPath = path.join(outDir, 'items.jsonl');
    await writeFile(jsonPath, JSON.stringify(items, null, 2), 'utf8');
    await writeFile(jsonlPath, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''), 'utf8');
    return { dir: outDir, jsonPath, jsonlPath, count: items.length };
}

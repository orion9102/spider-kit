/** 运行注册表：跟踪进行中的任务，保留最近完成的记录供 Web 界面回看。 */
export interface RunLogLine {
    ts: string;
    level: 'info' | 'warning' | 'error' | 'debug';
    message: string;
}

export interface RunRecord {
    runId: string;
    plugin: string;
    status: 'running' | 'done' | 'failed';
    startedAt: string;
    finishedAt?: string;
    itemCount?: number;
    stats?: { requestsTotal: number; requestsFailed: number; retryCount: number; durationMs: number };
    error?: string;
    /** 环形日志，最多 maxLogLines 条 */
    lines: RunLogLine[];
    jsonPath?: string;
    jsonlPath?: string;
}

const MAX_LOG_LINES = 500;
const MAX_FINISHED = 50;

class RunRegistry {
    private records = new Map<string, RunRecord>();

    start(runId: string, plugin: string): RunRecord {
        const rec: RunRecord = {
            runId,
            plugin,
            status: 'running',
            startedAt: new Date().toISOString(),
            lines: [],
        };
        this.records.set(runId, rec);
        return rec;
    }

    log(rec: RunRecord, level: RunLogLine['level'], message: string): void {
        rec.lines.push({ ts: new Date().toISOString(), level, message });
        if (rec.lines.length > MAX_LOG_LINES) rec.lines.splice(0, rec.lines.length - MAX_LOG_LINES);
    }

    finish(runId: string, payload: Partial<RunRecord>): void {
        const rec = this.records.get(runId);
        if (!rec) return;
        rec.status = 'done';
        rec.finishedAt = new Date().toISOString();
        Object.assign(rec, payload);
        this.trim();
    }

    fail(runId: string, error: string): void {
        const rec = this.records.get(runId);
        if (!rec) return;
        rec.status = 'failed';
        rec.finishedAt = new Date().toISOString();
        rec.error = error;
        this.trim();
    }

    private trim(): void {
        const finished = [...this.records.values()]
            .filter((r) => r.status !== 'running')
            .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''));
        while (finished.length > MAX_FINISHED) {
            this.records.delete(finished.shift()!.runId);
            finished.length--;
        }
    }

    get(runId: string): RunRecord | undefined {
        return this.records.get(runId);
    }

    list(): RunRecord[] {
        return [...this.records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    }
}

/** 全局单例：CLI 与 Web 界面共用 */
export const runs = new RunRegistry();

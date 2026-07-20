import fs from 'fs';
import path from 'path';
import { lexicalSearch, type RetrievalDocument } from './retrieval.js';
import type { SkillResult } from '../types/index.js';

export type FailureRecord = {
    ts: number;
    taskType: string;
    params: unknown;
    detail: string;
    failureType?: string;
    state: string;
};

export class FailureMemory {
    constructor(private readonly filePath = path.join(process.cwd(), 'memories', 'failures.jsonl')) {}

    record(taskType: string, params: unknown, result: SkillResult, state: string): void {
        if (result.ok) return;
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const record: FailureRecord = { ts: Date.now(), taskType, params, detail: result.detail, failureType: result.failureType, state };
            fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
        } catch {}
    }

    search(query: string, limit = 4): Array<RetrievalDocument<FailureRecord> & { score: number }> {
        const records = this.readRecent(80);
        const docs = records.map((record, index) => ({
            id: `${record.taskType}:${index}`,
            text: `task=${record.taskType}; params=${JSON.stringify(record.params)}; failure=${record.failureType ?? 'unknown'}; detail=${record.detail}; state=${record.state.slice(0, 240)}`,
            meta: record,
        }));
        return lexicalSearch(query, docs, limit);
    }

    private readRecent(limit: number): FailureRecord[] {
        try {
            if (!fs.existsSync(this.filePath)) return [];
            return fs.readFileSync(this.filePath, 'utf-8')
                .split(/\r?\n/)
                .filter(Boolean)
                .slice(-limit)
                .flatMap((line) => {
                    try { return [JSON.parse(line) as FailureRecord]; } catch { return []; }
                });
        } catch {
            return [];
        }
    }
}

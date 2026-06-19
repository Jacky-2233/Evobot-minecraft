import fs from 'fs';

const SESSION_LOG = 'logs/sessions.jsonl';

export interface SessionRecord {
    type: 'start' | 'end' | 'death' | 'task_done' | 'collect';
    timestamp: number;
    sessionId: string;
    data: Record<string, unknown>;
}

export class SessionStats {
    private _sessionId = '';
    private _startTime = 0;
    private _taskCount = 0;
    private _collectCount = 0;
    private _deathCount = 0;

    get sessionId(): string { return this._sessionId; }
    get uptimeMs(): number { return this._startTime > 0 ? Date.now() - this._startTime : 0; }
    get taskCount(): number { return this._taskCount; }
    get collectCount(): number { return this._collectCount; }
    get deathCount(): number { return this._deathCount; }

    start(): void {
        this._sessionId = `sess-${Date.now().toString(36)}`;
        this._startTime = Date.now();
        this._taskCount = 0;
        this._collectCount = 0;
        this._deathCount = 0;
        this.write('start', {});
    }

    end(): void {
        if (!this._sessionId) return;
        const dur = Date.now() - this._startTime;
        this.write('end', {
            durationMs: dur,
            durationStr: this.formatDuration(dur),
            tasksDone: this._taskCount,
            itemsCollected: this._collectCount,
            deaths: this._deathCount,
        });
        this._sessionId = '';
    }

    recordDeath(pos: Record<string, unknown>): void {
        this._deathCount++;
        this.write('death', { position: pos });
    }

    recordTask(type: string, ok: boolean): void {
        this._taskCount++;
        this.write('task_done', { type, ok });
    }

    recordCollect(item: string, count: number): void {
        this._collectCount += count;
        this.write('collect', { item, count });
    }

    summary(): string {
        if (!this._sessionId) return 'No active session';
        const dur = this.uptimeMs;
        return [
            `Session: ${this._sessionId}`,
            `Uptime: ${this.formatDuration(dur)}`,
            `Tasks: ${this._taskCount}`,
            `Collected: ${this._collectCount}`,
            `Deaths: ${this._deathCount}`,
        ].join(' | ');
    }

    private write(type: SessionRecord['type'], data: Record<string, unknown>): void {
        try {
            const dir = require('path').dirname(SESSION_LOG);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const record: SessionRecord = { type, timestamp: Date.now(), sessionId: this._sessionId, data };
            fs.appendFileSync(SESSION_LOG, JSON.stringify(record) + '\n');
        } catch {}
    }

    private formatDuration(ms: number): string {
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ${s % 60}s`;
        const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
    }
}

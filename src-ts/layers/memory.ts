/**
 * Memory Layer
 *
 * Persistent log of successes, failures, locations, and facts.
 * Used by the planner for context-aware decisions.
 */
import {
    MemoryEntry,
    TaskResult,
    WorldStateSummary,
    Vec3,
    GapReport,
} from '../types/index.js';

export interface MemoryConfig {
    maxEntries: number;
    /** Entry expires after this many ms (0 = never) */
    defaultExpiryMs: number;
    /** Minimum importance to keep */
    minImportance: number;
}

const DEFAULT_CONFIG: MemoryConfig = {
    maxEntries: 500,
    defaultExpiryMs: 300000, // 5 minutes
    minImportance: 1,
};

export class Memory {
    private entries: MemoryEntry[] = [];
    private config: MemoryConfig;
    private idx = 0;

    constructor(config?: Partial<MemoryConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /** Record a task result */
    recordTask(result: TaskResult): void {
        const ok = result.result.ok;
        this.add({
            type: ok ? 'success' : 'failure',
            summary: `${ok ? 'OK' : 'FAIL'} ${result.task.type}: ${result.result.detail}`,
            context: {
                taskType: result.task.type,
                params: result.task.params,
                elapsedMs: result.elapsedMs,
                retries: result.retries,
                failureType: result.result.failureType ?? 'none',
                source: result.task.source,
            },
            importance: ok ? 2 : 5,
        });
    }

    /** Record a noteworthy location */
    recordLocation(name: string, pos: Vec3, note?: string): void {
        this.add({
            type: 'location',
            summary: `${name} @ (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)})${note ? ` — ${note}` : ''}`,
            context: { name, pos, note: note ?? '' },
            importance: 3,
        });
    }

    /** Record a general fact or observation */
    recordFact(summary: string, context?: Record<string, unknown>, importance = 2): void {
        this.add({ type: 'fact', summary, context: context ?? {}, importance });
    }

    /** Record an AI plan */
    recordPlan(summary: string, context?: Record<string, unknown>): void {
        this.add({ type: 'strategy', summary, context: context ?? {}, importance: 4 });
    }

    /** Query recent failures for a given skill type */
    recentFailures(skillName: string, limit = 5): MemoryEntry[] {
        const now = Date.now();
        return this.entries
            .filter((e) => e.type === 'failure' && e.context?.taskType === skillName)
            .filter((e) => now - e.timestamp < 60000 * 10) // last 10 min
            .slice(-limit);
    }

    /** Check if a skill has been failing recently (avoid loops) */
    isSkillFailing(skillName: string, threshold = 3, windowMs = 120000): boolean {
        const now = Date.now();
        const recent = this.entries.filter(
            (e) =>
                e.type === 'failure' &&
                e.context?.taskType === skillName &&
                now - e.timestamp < windowMs,
        );
        return recent.length >= threshold;
    }

    /** Query recent location entries */
    recentLocations(limit = 10): MemoryEntry[] {
        const now = Date.now();
        return this.entries
            .filter((e) => e.type === 'location')
            .filter((e) => now - e.timestamp < 600000) // 10 min
            .slice(-limit);
    }

    /** Get all strategy entries */
    strategies(): MemoryEntry[] {
        return this.entries.filter((e) => e.type === 'strategy');
    }

    /** Get recent entries for context injection into LLM */
    getContextWindow(limit = 15): string {
        const recent = this.entries
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);

        if (recent.length === 0) return '(no memory yet)';

        return recent
            .map((e) => {
                const time = new Date(e.timestamp).toISOString().slice(11, 19);
                const tag = e.type.toUpperCase().padEnd(8);
                return `[${time}] ${tag} ${e.summary}`;
            })
            .join('\n');
    }

    /** Search entries by keyword */
    search(query: string, limit = 10): MemoryEntry[] {
        const q = query.toLowerCase();
        return this.entries
            .filter(
                (e) =>
                    e.summary.toLowerCase().includes(q) ||
                    JSON.stringify(e.context).toLowerCase().includes(q),
            )
            .slice(-limit);
    }

    /** Serialize to JSON (for persistence) */
    serialize(): string {
        return JSON.stringify(this.entries);
    }

    /** Deserialize from JSON (for persistence) */
    deserialize(data: string): void {
        try {
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
                this.entries = parsed;
            }
        } catch {
            console.warn('[Memory] Failed to deserialize memory');
        }
    }

    /** Record a gap analysis report */
    recordGapReport(report: GapReport): void {
        this.add({
            type: 'gap_report' as any,
            summary: `GapReport: ${report.findings.length} findings, ${report.totalFails}F/${report.totalSuccesses}S`,
            context: report as unknown as Record<string, unknown>,
            importance: 6,
        });
    }

    /** Get all failure entries within a time window */
    getFailuresInWindow(windowMs: number): MemoryEntry[] {
        const now = Date.now();
        return this.entries.filter(
            (e) => e.type === 'failure' && now - e.timestamp < windowMs,
        );
    }

    /** Get all success entries within a time window */
    getSuccessesInWindow(windowMs: number): MemoryEntry[] {
        const now = Date.now();
        return this.entries.filter(
            (e) => e.type === 'success' && now - e.timestamp < windowMs,
        );
    }

    private add(entry: Omit<MemoryEntry, 'id' | 'timestamp' | 'accessCount'>): void {
        const full: MemoryEntry = {
            ...entry,
            id: `mem-${this.idx++}`,
            timestamp: Date.now(),
            accessCount: 0,
        };

        this.entries.push(full);

        // Prune old entries
        if (this.entries.length > this.config.maxEntries) {
            this.prune();
        }
    }

    /** Total entries */
    get size(): number {
        return this.entries.length;
    }

    private prune(): void {
        const now = Date.now();
        this.entries = this.entries
            .filter((e) => {
                if (e.importance >= this.config.minImportance) return true;
                if (this.config.defaultExpiryMs > 0 && now - e.timestamp > this.config.defaultExpiryMs) {
                    return false;
                }
                return true;
            })
            .sort((a, b) => b.importance - a.importance)
            .slice(0, this.config.maxEntries);
    }
}

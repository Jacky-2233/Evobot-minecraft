/**
 * NaN Guard Utilities
 *
 * Provides finite-check helpers and a ring buffer tracer that
 * records the last N actions. When NaN is detected, the tracer
 * dumps the action history to help identify the root cause.
 */

export function isFiniteVec3(v: { x: number; y: number; z: number } | null | undefined): boolean {
    if (!v) return false;
    return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export function isFiniteNum(n: number | null | undefined): boolean {
    return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Ring buffer of recent actions. When NaN fires, dump it.
 */
export class NaNTracer {
    private buffer: string[] = [];
    private max: number;

    constructor(max = 20) {
        this.max = max;
    }

    /** Record an action that could lead to NaN */
    trace(action: string, extra?: Record<string, unknown>): void {
        const ts = new Date().toISOString().slice(11, 23);
        let line = `[${ts}] ${action}`;
        if (extra) {
            const parts: string[] = [];
            for (const [k, v] of Object.entries(extra)) {
                if (typeof v === 'object' && v !== null && 'x' in v) {
                    parts.push(`${k}=(${(v as any).x},${(v as any).y},${(v as any).z})`);
                } else {
                    parts.push(`${k}=${String(v)}`);
                }
            }
            if (parts.length) line += ` {${parts.join(', ')}}`;
        }
        this.buffer.push(line);
        if (this.buffer.length > this.max) this.buffer.shift();
    }

    /** Dump the trace to console — call when NaN detected */
    dump(label: string): string {
        const header = `\n=== NaN Trace (${label}) ===\n`;
        const body = this.buffer.join('\n');
        const footer = '\n=== End Trace ===\n';
        const out = header + body + footer;
        console.error(out);
        return out;
    }

    /** Get current trace as array */
    getTrace(): string[] {
        return [...this.buffer];
    }

    clear(): void {
        this.buffer = [];
    }
}

/** Global tracer instance */
export const nanTracer = new NaNTracer(20);

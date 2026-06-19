/**
 * Skill Base Class
 *
 * Every skill extends this. The executor calls `run()`, never `execute()` directly.
 * `run()` wraps `execute()` with timeout, retry, and proper cleanup.
 */
import { ISkill, SkillContext, SkillResult, FailureType } from '../types/index.js';

export abstract class BaseSkill<P = unknown> implements ISkill<P> {
    abstract readonly name: string;
    abstract readonly description: string;
    readonly interruptible = true;
    readonly defaultTimeoutMs = 10000;
    readonly maxRetries = 1;

    private _running = false;
    private _cancelController: AbortController | null = null;

    get isRunning(): boolean {
        return this._running;
    }

    /** Subclasses implement this — pure logic, no timeout/retry boilerplate */
    protected abstract _execute(params: P, ctx: SkillContext): Promise<SkillResult>;

    /** Executor calls this. Handles timeout, retry, abort, cleanup. */
    async run(
        params: P,
        timeoutMs?: number,
        retries?: number,
    ): Promise<SkillResult> {
        const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
        const effectiveRetries = retries ?? this.maxRetries;
        let lastResult: SkillResult = { ok: false, detail: 'Not attempted' };

        for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
            if (attempt > 0) {
                // Brief cooldown between retries
                await this.sleep(500);
            }

            this._cancelController = new AbortController();
            const startedAt = Date.now();
            const ctx: SkillContext = {
                startedAt,
                deadline: startedAt + effectiveTimeout,
                signal: this._cancelController.signal,
                log: (level, msg) => {
                    const prefix = `[${this.name}]`;
                    if (typeof console?.[level] === 'function') {
                        console[level](`${prefix} ${msg}`);
                    }
                },
            };

            this._running = true;

            try {
                const deadlineTimer =
                    effectiveTimeout < Infinity
                        ? setTimeout(() => this._cancelController?.abort('timeout'), effectiveTimeout)
                        : null;

                lastResult = await this._execute(params, ctx);

                if (deadlineTimer) clearTimeout(deadlineTimer);

                if (lastResult.ok) {
                    return lastResult;
                }

                // Non-retriable failures
                if (lastResult.failureType === 'not_possible' || lastResult.failureType === 'cancelled') {
                    return lastResult;
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('timeout') || msg.includes('abort')) {
                    lastResult = {
                        ok: false,
                        detail: `Timeout after ${Date.now() - startedAt}ms`,
                        failureType: 'timeout',
                    };
                } else {
                    lastResult = {
                        ok: false,
                        detail: msg,
                        failureType: 'internal_error',
                    };
                }
            } finally {
                this._running = false;
                this._cancelController = null;
            }
        }

        return lastResult;
    }

    cancel(): void {
        this._cancelController?.abort('cancelled');
        this._running = false;
    }

    protected sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    protected result(
        ok: boolean,
        detail: string,
        failureType?: FailureType,
        payload?: unknown,
    ): SkillResult {
        return { ok, detail, failureType, payload };
    }
}

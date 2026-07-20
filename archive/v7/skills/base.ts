import { ISkill, SkillResult, FailureType } from '../types/index.js';

export abstract class BaseSkill<P = unknown> implements ISkill<P> {
    abstract readonly name: string;
    readonly defaultTimeoutMs: number = 10000;
    private _running = false;
    private _abort: AbortController | null = null;

    get isRunning(): boolean { return this._running; }

    protected abstract _execute(params: P, signal: AbortSignal): Promise<SkillResult>;

    async run(params: P): Promise<SkillResult> {
        this._abort = new AbortController();
        this._running = true;
        const deadline = Date.now() + this.defaultTimeoutMs;
        const timer = setTimeout(() => this._abort?.abort('timeout'), this.defaultTimeoutMs);
        try {
            const result = await this._execute(params, this._abort.signal);
            return result;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, detail: msg, failureType: 'internal_error' };
        } finally {
            clearTimeout(timer);
            this._running = false;
            this._abort = null;
        }
    }

    cancel(): void { this._abort?.abort('cancelled'); this._running = false; }
    protected result(ok: boolean, detail: string, failureType?: FailureType): SkillResult {
        return { ok, detail, failureType };
    }
}

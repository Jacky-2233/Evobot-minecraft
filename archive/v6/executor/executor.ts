/**
 * Task Executor
 *
 * Central execution engine. All tasks go through here.
 * Handles: priority queue, concurrent limit, interrupt, retry, logging.
 */
import {
    TaskDefinition,
    TaskResult,
    SkillResult,
    ISkill,
} from '../types/index.js';

export interface ExecutorConfig {
    /** Max concurrent tasks (always 1 for safety) */
    maxConcurrent: number;
    /** Default timeout if task doesn't specify */
    defaultTimeoutMs: number;
    /** Max history entries kept */
    maxHistory: number;
}

const DEFAULT_CONFIG: ExecutorConfig = {
    maxConcurrent: 1,
    defaultTimeoutMs: 30000,
    maxHistory: 100,
};

export class Executor {
    private queue: TaskDefinition[] = [];
    private currentTask: TaskDefinition | null = null;
    private registry: Map<string, ISkill> = new Map();
    private history: TaskResult[] = [];
    private config: ExecutorConfig;
    private _paused = false;
    private _onComplete: ((result: TaskResult) => void) | null = null;
    private _onTaskStart: ((task: TaskDefinition) => void) | null = null;

    constructor(config?: Partial<ExecutorConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /** Register a skill so it can be called by task type */
    registerSkill(skill: ISkill): void {
        this.registry.set(skill.name, skill);
        this.log('info', `Registered skill: ${skill.name}`);
    }

    /** Unregister */
    unregisterSkill(name: string): void {
        this.registry.delete(name);
    }

    /** Add a task to the queue */
    enqueue(task: TaskDefinition): void {
        this.queue.push(task);
        // Sort by priority descending
        this.queue.sort((a, b) => b.priority - a.priority);
        this.log('info', `Enqueued: ${task.type} p=${task.priority} (queue depth: ${this.queue.length})`);
    }

    /** Pause execution (doesn't cancel current task) */
    pause(): void {
        this._paused = true;
    }

    resume(): void {
        this._paused = false;
    }

    /** Cancel current task and clear queue */
    clear(): void {
        this.cancelCurrent();
        this.queue = [];
        this._paused = false;
        this.log('info', 'Cleared all tasks');
    }

    /** Query current state */
    isIdle(): boolean {
        return !this.currentTask && this.queue.length === 0;
    }

    getCurrentTask(): TaskDefinition | null {
        return this.currentTask;
    }

    getQueueDepth(): number {
        return this.queue.length;
    }

    getHistory(limit = 10): TaskResult[] {
        return this.history.slice(-limit);
    }

    /**
     * Main tick — call this in the update loop.
     * Executes next task if idle and queue non-empty.
     */
    async tick(): Promise<void> {
        if (this._paused) return;
        if (this.currentTask) return;
        if (this.queue.length === 0) return;

        const task = this.queue.shift()!;
        this.currentTask = task;

        const skill = this.registry.get(task.type);
        if (!skill) {
            this.log('warn', `Unknown skill: ${task.type}`);
            this.recordResult(task, { ok: false, detail: `Unknown skill: ${task.type}`, failureType: 'internal_error' }, 0, 0);
            this.currentTask = null;
            return;
        }

        const startedAt = Date.now();
        this.log('info', `Executing: ${task.type} id=${task.id}`);
        if (this._onTaskStart) this._onTaskStart(task);

        let result: SkillResult;
        let retries = 0;
        const maxRetries = (task.params.maxRetries as number) ?? skill.maxRetries;

        do {
            result = await skill.run(task.params);
            retries++;
            if (result.ok) break;
        } while (retries < maxRetries && result.failureType !== 'cancelled' && result.failureType !== 'not_possible');

        const elapsed = Date.now() - startedAt;
        this.recordResult(task, result, elapsed, retries);
        this.currentTask = null;
    }

    private cancelCurrent(): void {
        if (!this.currentTask) return;
        const skill = this.registry.get(this.currentTask.type);
        if (skill?.isRunning) {
            skill.cancel();
        }
        this.log('warn', `Cancelled: ${this.currentTask.type}`);
        this.currentTask = null;
    }

    private recordResult(
        task: TaskDefinition,
        result: SkillResult,
        elapsedMs: number,
        retries: number,
    ): void {
        const entry: TaskResult = { task, result, elapsedMs, retries };
        this.history.push(entry);
        if (this.history.length > this.config.maxHistory) {
            this.history = this.history.slice(-this.config.maxHistory);
        }
        this.log(
            result.ok ? 'info' : 'warn',
            `${task.type} ${result.ok ? 'OK' : 'FAIL'} (${elapsedMs}ms, ${retries}r): ${result.detail}`,
        );
        if (this._onComplete) {
            this._onComplete(entry);
        }
    }

    /** Set callback invoked after every task completes */
    set onComplete(cb: ((result: TaskResult) => void) | null) {
        this._onComplete = cb;
    }

    /** Set callback invoked when a task starts executing */
    set onTaskStart(cb: ((task: TaskDefinition) => void) | null) {
        this._onTaskStart = cb;
    }

    private log(level: 'info' | 'warn' | 'error', msg: string): void {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`[Executor ${ts}] ${level.toUpperCase()}: ${msg}`);
    }
}

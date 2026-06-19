/**
 * Step Executor
 *
 * Executes step sequences atomically. Each step completes in <5s.
 * Checkpoints are saved after each step for resume on disconnect.
 * Designed for 8-second connection windows.
 */
import type { Bot } from 'mineflayer';
import type {
    StepDefinition,
    StepSequence,
    StepContext,
    StepResult,
    StepCheckpoint,
    StepState,
    FailureType,
} from '../types/index.js';
import { CheckpointManager } from '../layers/checkpoint.js';

export interface StepExecutorConfig {
    /** Default timeout for steps that don't specify one */
    defaultStepTimeoutMs: number;
    /** Max history entries kept */
    maxHistory: number;
    /** Log level for step execution */
    logLevel: 'info' | 'warn' | 'error';
}

const DEFAULT_CONFIG: StepExecutorConfig = {
    defaultStepTimeoutMs: 3000,
    maxHistory: 50,
    logLevel: 'info',
};

export class StepExecutor {
    private bot: Bot;
    private checkpoint: CheckpointManager;
    private config: StepExecutorConfig;
    private currentSequence: StepSequence | null = null;
    private _running = false;
    private _cancelled = false;
    private history: StepExecutionRecord[] = [];
    private _onStepComplete: ((record: StepExecutionRecord) => void) | null = null;
    private _onSequenceComplete: ((sequence: StepSequence, result: StepResult) => void) | null = null;

    constructor(
        bot: Bot,
        checkpoint: CheckpointManager,
        config?: Partial<StepExecutorConfig>,
    ) {
        this.bot = bot;
        this.checkpoint = checkpoint;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /** Execute a step sequence */
    async execute(sequence: StepSequence): Promise<StepResult> {
        if (this._running) {
            return { ok: false, detail: 'Already executing a sequence', failureType: 'internal_error' };
        }

        this._running = true;
        this._cancelled = false;
        this.currentSequence = sequence;

        this.log('info', `Starting sequence: ${sequence.name} (${sequence.steps.length} steps)`);

        try {
            for (let i = sequence.currentStepIndex; i < sequence.steps.length; i++) {
                if (this._cancelled) {
                    return { ok: false, detail: 'Sequence cancelled', failureType: 'cancelled' };
                }

                const step = sequence.steps[i];
                sequence.currentStepIndex = i;

                // Check dependencies
                if (step.dependsOn) {
                    const completedIds = sequence.steps
                        .slice(0, i)
                        .map(s => s.id);
                    const missing = step.dependsOn.filter(d => !completedIds.includes(d));
                    if (missing.length > 0) {
                        this.log('warn', `Step ${step.id} missing dependencies: ${missing.join(', ')}`);
                        return {
                            ok: false,
                            detail: `Missing dependencies: ${missing.join(', ')}`,
                            failureType: 'internal_error',
                        };
                    }
                }

                // Execute step with timeout
                const result = await this.executeStep(step, sequence.state, i, sequence.steps.length);

                // Record execution
                const record: StepExecutionRecord = {
                    sequenceId: sequence.id,
                    sequenceName: sequence.name,
                    stepId: step.id,
                    stepName: step.name,
                    stepType: step.type,
                    stepIndex: i,
                    totalSteps: sequence.steps.length,
                    result,
                    elapsedMs: 0, // Will be updated by executeStep
                    timestamp: Date.now(),
                };
                this.history.push(record);
                if (this.history.length > this.config.maxHistory) {
                    this.history = this.history.slice(-this.config.maxHistory);
                }

                // Notify step complete
                if (this._onStepComplete) {
                    this._onStepComplete(record);
                }

                // Update state from result
                if (result.state) {
                    Object.assign(sequence.state, result.state);
                }

                // Save checkpoint after each successful step
                if (result.ok) {
                    sequence.currentStepIndex = i + 1;
                    this.saveStepCheckpoint(sequence);
                } else {
                    // Step failed — save checkpoint at current position for resume
                    this.saveStepCheckpoint(sequence);
                    return result;
                }
            }

            // All steps completed
            const successResult: StepResult = {
                ok: true,
                detail: `Completed sequence: ${sequence.name}`,
            };

            this.log('info', `Sequence completed: ${sequence.name}`);

            // Notify sequence complete
            if (this._onSequenceComplete) {
                this._onSequenceComplete(sequence, successResult);
            }

            // Clear step checkpoint on successful completion
            this.checkpoint.clearStepCheckpoint();

            return successResult;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log('error', `Sequence error: ${msg}`);
            return {
                ok: false,
                detail: msg,
                failureType: 'internal_error',
            };
        } finally {
            this._running = false;
            this.currentSequence = null;
        }
    }

    /** Cancel the current sequence */
    cancel(): void {
        this._cancelled = true;
        this.log('warn', 'Sequence cancelled');
    }

    /** Check if currently executing */
    get isRunning(): boolean {
        return this._running;
    }

    /** Get current sequence */
    getCurrentSequence(): StepSequence | null {
        return this.currentSequence;
    }

    /** Get execution history */
    getHistory(limit = 10): StepExecutionRecord[] {
        return this.history.slice(-limit);
    }

    /** Resume a sequence from checkpoint */
    async resumeFromCheckpoint(): Promise<StepResult | null> {
        const stepCkpt = this.checkpoint.loadStepCheckpoint();
        if (!stepCkpt) {
            return null;
        }

        this.log('info', `Resuming sequence from checkpoint: ${stepCkpt.sequenceName} step ${stepCkpt.currentStepIndex}`);

        // Note: We can't fully reconstruct the step sequence from checkpoint
        // because step definitions contain functions. The caller must provide
        // the sequence with steps already defined, and we'll set the state.
        return null;
    }

    /** Save step checkpoint */
    private saveStepCheckpoint(sequence: StepSequence): void {
        const checkpoint: StepCheckpoint = {
            sequenceId: sequence.id,
            sequenceName: sequence.name,
            currentStepIndex: sequence.currentStepIndex,
            state: sequence.state,
            completedSteps: sequence.steps
                .slice(0, sequence.currentStepIndex)
                .map(s => s.id),
            progress: {
                total: sequence.steps.length,
                completed: sequence.currentStepIndex,
            },
            savedAt: Date.now(),
        };

        this.checkpoint.saveStepCheckpoint(checkpoint);
    }

    /** Execute a single step with timeout */
    private async executeStep(
        step: StepDefinition,
        state: StepState,
        stepIndex: number,
        totalSteps: number,
    ): Promise<StepResult & { elapsedMs: number }> {
        const startedAt = Date.now();
        const timeoutMs = step.timeoutMs || this.config.defaultStepTimeoutMs;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const ctx: StepContext = {
            bot: this.bot,
            state,
            signal: controller.signal,
            log: (msg) => this.log('info', `[${step.id}] ${msg}`),
            stepIndex,
            totalSteps,
        };

        try {
            const result = await Promise.race([
                step.execute(ctx),
                new Promise<never>((_, reject) => {
                    controller.signal.addEventListener('abort', () => {
                        reject(new Error('Step timeout'));
                    });
                }),
            ]);

            clearTimeout(timeout);
            return { ...result, elapsedMs: Date.now() - startedAt };
        } catch (err: unknown) {
            clearTimeout(timeout);
            const msg = err instanceof Error ? err.message : String(err);
            const isTimeout = msg.includes('timeout') || controller.signal.aborted;

            return {
                ok: false,
                detail: isTimeout ? `Step timeout after ${timeoutMs}ms` : msg,
                failureType: isTimeout ? 'timeout' : 'internal_error',
                elapsedMs: Date.now() - startedAt,
            };
        }
    }

    /** Set callback for step completion */
    set onStepComplete(cb: ((record: StepExecutionRecord) => void) | null) {
        this._onStepComplete = cb;
    }

    /** Set callback for sequence completion */
    set onSequenceComplete(cb: ((sequence: StepSequence, result: StepResult) => void) | null) {
        this._onSequenceComplete = cb;
    }

    private log(level: 'info' | 'warn' | 'error', msg: string): void {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`[StepExec ${ts}] ${level.toUpperCase()}: ${msg}`);
    }
}

/** Record of a single step execution */
export interface StepExecutionRecord {
    sequenceId: string;
    sequenceName: string;
    stepId: string;
    stepName: string;
    stepType: string;
    stepIndex: number;
    totalSteps: number;
    result: StepResult;
    elapsedMs: number;
    timestamp: number;
}
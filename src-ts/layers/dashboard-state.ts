/**
 * Dashboard State Provider
 *
 * Aggregates state from all v6 modules into a single DashboardState
 * for the web dashboard. Called once per second by the server.
 */
import type { Bot } from 'mineflayer';
import type { PositionHealth } from './position-health.js';
import type { CheckpointManager } from './checkpoint.js';
import type { GapDetector } from './gap-detector.js';
import type { Memory } from './memory.js';
import type { Executor } from '../executor/executor.js';
import type { StepExecutor } from '../executor/step-executor.js';
import type { GapFinding } from '../types/index.js';
import type { AgentOrchestrator } from './orchestrator.js';

export interface DashboardState {
    bot: {
        online: boolean;
        reconnecting: boolean;
        reconnectInSec?: number;
        lastDisconnectReason?: string;
        uptimeMs: number;
        username: string;
        server: string;
    };
    survival: {
        health: number;
        food: number;
        armor: number;
        heldItem?: string;
        inWater: boolean;
        positionHealth: 'trusted' | 'degraded' | 'invalid';
    };
    task: {
        currentGoal?: string;
        currentTask?: string;
        currentSkill?: string;
        progress?: string;
        retries?: number;
        timeoutAt?: number;
        recovering?: boolean;
    };
    checkpoint: {
        exists: boolean;
        lastSavedAt?: number;
        activeTask?: string;
        progress?: string;
    };
    stepExecution?: {
        active: boolean;
        sequenceName?: string;
        currentStep?: string;
        progress?: string;
        stepHistory: Array<{
            stepName: string;
            ok: boolean;
            elapsedMs: number;
        }>;
    };
    position: { x: number; y: number; z: number } | null;
    inventory: {
        totalSlots: number;
        usedSlots: number;
        items: string[];
    };
    recentEvents: DashboardEvent[];
    recentFailures: DashboardFailure[];
    gapFindings: DashboardGapFinding[];
    goal?: {
        activeId: string | null;
        activeDescription: string;
        activeType: string;
        pendingCount: number;
        queue: Array<{ id: string; description: string; type: string }>;
    };
    control?: {
        owner: string;
        taskType: string;
        lastForceAcquireReason: string;
        lastInterruptReason: string | null;
        acquiredAt: number;
    };
}

export interface DashboardEvent {
    at: number;
    type: string;
    message: string;
}

export interface DashboardFailure {
    at: number;
    actionKey: string;
    failReason: string;
    summary: string;
}

export interface DashboardGapFinding {
    at: number;
    category: string;
    summary: string;
    recommendedAction: string;
    confidence: number;
    debugReason?: string[];
}

export class DashboardStateProvider {
    private bot: Bot;
    private positionHealth: PositionHealth | null;
    private checkpointManager: CheckpointManager;
    private gapDetector: GapDetector | null;
    private memory: Memory;
    private executor: Executor;
    private stepExecutor: StepExecutor | null;
    private orchestrator: AgentOrchestrator | null;
    private coreStartTime: number;

    private _recentEvents: DashboardEvent[] = [];

    constructor(
        bot: Bot,
        positionHealth: PositionHealth | null,
        checkpointManager: CheckpointManager,
        gapDetector: GapDetector | null,
        memory: Memory,
        executor: Executor,
        coreStartTime: number,
        stepExecutor?: StepExecutor,
        orchestrator?: AgentOrchestrator,
    ) {
        this.bot = bot;
        this.positionHealth = positionHealth;
        this.checkpointManager = checkpointManager;
        this.gapDetector = gapDetector;
        this.memory = memory;
        this.executor = executor;
        this.stepExecutor = stepExecutor ?? null;
        this.orchestrator = orchestrator ?? null;
        this.coreStartTime = coreStartTime;
    }

    /** Push an observable event (called by core on notable occurrences) */
    pushEvent(type: string, message: string): void {
        this._recentEvents.unshift({ at: Date.now(), type, message });
        if (this._recentEvents.length > 50) this._recentEvents = this._recentEvents.slice(0, 50);
    }

    /** Get recent events for Commander input */
    getRecentEvents(limit = 10): DashboardEvent[] {
        return this._recentEvents.slice(0, limit);
    }

    /** Build the full dashboard state snapshot */
    getState(): DashboardState {
        const now = Date.now();
        const bot = this.bot;

        // ─── Bot info ─────────────────────────────────
        const botInfo: DashboardState['bot'] = {
            online: !!bot?.entity,
            reconnecting: false,
            username: bot?.username ?? 'unknown',
            server: (bot as any)?._client?.socket?.remoteAddress ?? 'unknown',
            uptimeMs: now - this.coreStartTime,
        };

        // ─── Survival ─────────────────────────────────
        const pos = bot?.entity?.position;
        const heldItem = bot?.heldItem;
        const survival: DashboardState['survival'] = {
            health: bot?.health ?? 0,
            food: bot?.food ?? 0,
            armor: 0, // mineflayer doesn't expose armor easily
            heldItem: heldItem ? `${heldItem.name} x${heldItem.count}` : undefined,
            inWater: false,
            positionHealth: this.positionHealth?.state ?? 'degraded',
        };
        // Check if bot is in water
        if (pos && bot?.blockAt) {
            const block = bot.blockAt(pos);
            survival.inWater = block?.name === 'water' || block?.name === 'lava';
        }

        // ─── Task ─────────────────────────────────────
        const curTask = this.executor.getCurrentTask();
        const taskInfo: DashboardState['task'] = {};
        if (curTask) {
            taskInfo.currentSkill = curTask.type;
            taskInfo.currentTask = curTask.id;
            taskInfo.currentGoal = (curTask.params as any)?.target
                ?? (curTask.params as any)?.goal
                ?? undefined;
            taskInfo.retries = 0; // executor doesn't expose current retry count
            taskInfo.recovering = false;
        }

        // ─── Checkpoint ───────────────────────────────
        const ckpt = this.checkpointManager.load();
        const checkpointInfo: DashboardState['checkpoint'] = {
            exists: ckpt !== null,
            lastSavedAt: ckpt?.timestamp,
        };
        if (ckpt?.activeTask) {
            checkpointInfo.activeTask = `${ckpt.activeTask.type} (${ckpt.activeTask.completed}/${ckpt.activeTask.target})`;
            checkpointInfo.progress = `${ckpt.activeTask.completed}/${ckpt.activeTask.target}`;
        }

        // ─── Position ─────────────────────────────────
        const position = pos
            ? { x: pos.x, y: pos.y, z: pos.z }
            : null;

        // ─── Inventory ────────────────────────────────
        const items = bot?.inventory?.items() ?? [];
        const inventoryInfo: DashboardState['inventory'] = {
            totalSlots: 36,
            usedSlots: items.length,
            items: items.map((i) => `${i.name} x${i.count}`),
        };

        // ─── Recent failures ──────────────────────────
        const recentFails = this.memory.getFailuresInWindow(600000).slice(-10);
        const recentFailures: DashboardFailure[] = recentFails.map((e) => ({
            at: e.timestamp,
            actionKey: (e.context?.taskType as string) ?? 'unknown',
            failReason: (e.context?.failureType as string) ?? 'unknown',
            summary: e.summary,
        })).reverse();

        // ─── Gap findings ──────────────────────────────
        const latestReport = this.gapDetector?.latestReport;
        const gapFindings: DashboardGapFinding[] = (latestReport?.findings ?? []).slice(0, 10).map((f: GapFinding) => ({
            at: latestReport!.timestamp,
            category: f.category,
            summary: f.summary,
            recommendedAction: f.recommendedAction,
            confidence: f.confidence,
            debugReason: f.debugReason,
        }));

        // ─── Step execution ────────────────────────────
        const stepInfo: DashboardState['stepExecution'] = this.stepExecutor
            ? {
                active: this.stepExecutor.isRunning,
                sequenceName: this.stepExecutor.getCurrentSequence()?.name,
                currentStep: this.stepExecutor.getCurrentSequence()
                    ? `Step ${(this.stepExecutor.getCurrentSequence()?.currentStepIndex ?? 0) + 1}/${this.stepExecutor.getCurrentSequence()?.steps.length}`
                    : undefined,
                progress: this.stepExecutor.getCurrentSequence()
                    ? `${this.stepExecutor.getCurrentSequence()?.currentStepIndex}/${this.stepExecutor.getCurrentSequence()?.steps.length}`
                    : undefined,
                stepHistory: this.stepExecutor.getHistory(5).map(r => ({
                    stepName: r.stepName,
                    ok: r.result.ok,
                    elapsedMs: r.elapsedMs,
                })),
            }
            : undefined;

        const goalInfo = this.orchestrator
            ? {
                activeId: (this.orchestrator as any)?._goalManager?.activeGoalId ?? null,
                activeDescription: (this.orchestrator as any)?._goalManager?.activeGoal?.description ?? 'none',
                activeType: (this.orchestrator as any)?._goalManager?.activeGoal?.type ?? 'none',
                pendingCount: (this.orchestrator as any)?._goalManager?.pendingGoals?.length ?? 0,
                queue: ((this.orchestrator as any)?._goalManager?.pendingGoals ?? []).slice(0, 5).map(
                    (g: any) => ({ id: g.id, description: g.description, type: g.type })
                ),
            }
            : undefined;

        const controlInfo = this.orchestrator
            ? {
                owner: this.orchestrator.actionControl.owner,
                taskType: this.orchestrator.actionControl.lockState.taskType ?? '',
                lastForceAcquireReason: this.orchestrator.actionControl.lastForceAcquireReason,
                lastInterruptReason: this.orchestrator.lastInterruptReason,
                acquiredAt: this.orchestrator.actionControl.acquiredAt,
            }
            : undefined;

        return {
            bot: botInfo,
            survival,
            task: taskInfo,
            checkpoint: checkpointInfo,
            stepExecution: stepInfo,
            position,
            inventory: inventoryInfo,
            recentEvents: this._recentEvents.slice(0, 30),
            recentFailures,
            gapFindings,
            goal: goalInfo,
            control: controlInfo,
        };
    }
}

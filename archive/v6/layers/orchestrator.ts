/**
 * AgentOrchestrator — 统一节拍器
 *
 * 核心原则：
 * 1. 只有 Orchestrator 能下发任务给 Executor
 * 2. 其他模块只能 submitIntent() 或 raiseEmergency()
 * 3. Safety 能抢锁，但不能直接控制身体
 * 4. 同一时刻只有一个控制源
 */
import type { Executor } from '../executor/executor.js';
import type { StepExecutor } from '../executor/step-executor.js';
import type { Bot } from 'mineflayer';
import { ActionController, type ControlOwner } from './action-controller.js';
import { Arbiter } from './arbiter.js';
import type { StepSequence } from '../types/index.js';
import type { GoalManager } from './goal-manager.js';

export type IntentSource = 'chat' | 'console' | 'auto' | 'safety' | 'checkpoint' | 'gap' | 'planner';
export type IntentType = 'user_goal' | 'direct_task' | 'emergency' | 'resume' | 'idle_tick' | 'status_query';

export interface AgentIntent {
    id: string;
    source: IntentSource;
    type: IntentType;
    /** Human description for logging */
    text: string;
    /** High-level goal (for user_goal type) */
    goal?: string;
    /** Task to execute (for direct_task type) */
    taskType?: string;
    taskParams?: Record<string, unknown>;
    priority: number;
    createdAt: number;
    /** Step sequence (for step-based tasks) */
    stepSequence?: StepSequence;
    /** Safety emergency — skip arbiter, forceAcquire lock */
    isEmergency?: boolean;
    /** Optional goal this intent belongs to */
    goalId?: string;
}

export interface OrchestratorDecision {
    accepted: boolean;
    reason?: string;
    intentId: string;
    /** If rejected but requeued with adjusted priority */
    adjusted?: boolean;
}

export interface OrchestratorDeps {
    bot: Bot;
    executor: Executor;
    stepExecutor: StepExecutor;
    arbiter: Arbiter;
    addTask: (task: { type: string; params: Record<string, unknown>; priority: number; source: string }) => string;
    executeStepSequence: (seq: StepSequence) => Promise<any>;
    goalManager?: GoalManager;
}

export class AgentOrchestrator {
    private deps: OrchestratorDeps;
    private actionController: ActionController;
    private arbiter: Arbiter;
    private _pendingIntents: AgentIntent[] = [];
    private _lastInterruptReason: string | null = null;
    private _goalManager: GoalManager | null;

    constructor(deps: OrchestratorDeps) {
        this.deps = deps;
        this.actionController = new ActionController(deps.executor);
        this.arbiter = deps.arbiter;
        this._goalManager = deps.goalManager ?? null;
    }

    get actionControl(): ActionController { return this.actionController; }
    get pendingIntents(): number { return this._pendingIntents.length; }
    get lastInterruptReason(): string | null { return this._lastInterruptReason; }

    /** 统一入口：所有模块通过这里提交意图 */
    submitIntent(intent: Omit<AgentIntent, 'id' | 'createdAt'>): OrchestratorDecision {
        const id = `intent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const full: AgentIntent = { ...intent, id, createdAt: Date.now() };

        // Safety emergency — 直接抢锁，跳过 arbiter
        if (intent.isEmergency) {
            this.actionController.forceAcquire('safety', intent.text);
            this.executeIntent(full);
            return { accepted: true, intentId: id };
        }

        // 检查锁状态
        if (this.actionController.isLocked && this.actionController.owner !== 'executor') {
            return { accepted: false, reason: `Lock held by ${this.actionController.owner}`, intentId: id };
        }

        // 按优先级插入等待队列
        this._pendingIntents.push(full);
        this._pendingIntents.sort((a, b) => b.priority - a.priority);

        // 如果 executor 空闲，立即执行
        if (this.deps.executor.isIdle()) {
            return this.processNext();
        }

        return { accepted: true, intentId: id };
    }

    /** 处理下一个等待的 intent */
    processNext(): OrchestratorDecision {
        if (this._pendingIntents.length === 0) {
            return { accepted: false, reason: 'No pending intents', intentId: '' };
        }

        // 如果锁被 safety 持有，跳过
        if (this.actionController.isLocked && this.actionController.owner === 'safety') {
            return { accepted: false, reason: 'Safety lock active', intentId: '' };
        }

        const intent = this._pendingIntents.shift()!;

        // Safety 紧急任务 bypass arbiter
        if (intent.isEmergency) {
            this.actionController.forceAcquire('safety', intent.text);
            this.executeIntent(intent);
            return { accepted: true, intentId: intent.id };
        }

        // Arbiter 校验
        const arbiterOk = this.arbiter.validate({
            health: this.deps.bot.health,
            food: this.deps.bot.food,
            positionHealth: ((this.deps.bot as any).positionHealth?.state?.[0] ?? 'trusted') as any,
            isReconnecting: false,
            hostileNearby: false,
            recentFailCount: 0,
            hasFoodInInventory: this.deps.bot.inventory?.items().some(i =>
                ['cooked', 'steak', 'porkchop', 'bread', 'apple']
                    .some(s => i.name.includes(s))) ?? false,
        }, { mode: 'switch_goal', goal: intent.goal, tasks: intent.taskType ? [{ type: intent.taskType, params: intent.taskParams ?? {}, priority: intent.priority }] : [], reason: intent.text, riskLevel: 'low' });

        if (!arbiterOk.approved && !arbiterOk.vetoReason?.includes('vetoed')) {
            return { accepted: false, reason: arbiterOk.vetoReason ?? 'Arbiter rejected', intentId: intent.id };
        }

        this.executeIntent(intent);
        return { accepted: true, intentId: intent.id };
    }

    /** 实际执行 intent */
    private executeIntent(intent: AgentIntent): void {
        if (intent.stepSequence) {
            this.actionController.acquire('executor', intent.taskType);
            this.deps.executeStepSequence(intent.stepSequence).finally(() => {
                this.actionController.release('executor');
            });
            return;
        }

        if (intent.taskType) {
            this.actionController.acquire('executor', intent.taskType);
            this.deps.addTask({
                type: intent.taskType,
                params: intent.taskParams ?? {},
                priority: intent.priority,
                source: intent.source as any,
            });
            // Lock released when executor finishes (via onComplete hook)
        }
    }

    /** Executor 完成回调 — 释放锁 + 处理下一个 intent */
    onExecutorComplete(): void {
        this.actionController.release('executor');
        this.processNext();
    }

    /** Safety 触发紧急事件 */
    raiseEmergency(text: string, taskType: string, params: Record<string, unknown>): void {
        this.submitIntent({
            source: 'safety',
            type: 'emergency',
            text,
            taskType,
            taskParams: params,
            priority: 100,
            isEmergency: true,
        });
    }

    /** 中断当前所有运行中的任务（保留 goal，只取消执行） */
    interruptAllRunning(reason: string): void {
        this._lastInterruptReason = reason;
        this._pendingIntents = [];
        this.deps.executor.clear();
        this.actionController.forceAcquire('recovery', reason);
        setTimeout(() => this.actionController.release('recovery'), 2000);
    }
}

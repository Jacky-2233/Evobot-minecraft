import type { Goal, GoalPriority, GoalStatus } from '../types/index.js';

export class GoalManager {
    private _goals: Map<string, Goal> = new Map();
    private _activeGoalId: string | null = null;
    private _pausedGoal: Goal | null = null;
    private _autoGoalCooldown = 0;

    get activeGoal(): Goal | null {
        if (!this._activeGoalId) return null;
        const g = this._goals.get(this._activeGoalId);
        if (!g || g.status !== 'active') return null;
        return g;
    }

    get activeGoalId(): string | null { return this._activeGoalId; }

    get pendingGoals(): Goal[] {
        return Array.from(this._goals.values())
            .filter(g => g.status === 'pending')
            .sort((a, b) => {
                const order: Record<string, number> = { survival: 0, user: 1, autonomous: 2 };
                return (order[a.type] ?? 9) - (order[b.type] ?? 9);
            });
    }

    get allGoals(): Goal[] {
        return Array.from(this._goals.values())
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    addGoal(input: {
        type: GoalPriority;
        description: string;
        metadata?: Record<string, unknown>;
    }): string {
        const id = `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const goal: Goal = {
            id,
            type: input.type,
            description: input.description,
            status: 'pending',
            createdAt: Date.now(),
            taskIds: [],
            metadata: input.metadata ?? {},
        };
        this._goals.set(id, goal);
        console.log(`[GoalManager] Added goal: ${input.type} — ${input.description} (${id})`);
        return id;
    }

    setActive(id: string): boolean {
        const goal = this._goals.get(id);
        if (!goal || goal.status === 'completed' || goal.status === 'failed' || goal.status === 'cancelled') {
            return false;
        }
        if (this._activeGoalId) {
            const prev = this._goals.get(this._activeGoalId);
            if (prev && prev.status === 'active') {
                prev.status = 'pending';
            }
        }
        goal.status = 'active';
        goal.activatedAt = Date.now();
        this._activeGoalId = id;
        console.log(`[GoalManager] Active goal: ${goal.type} — ${goal.description}`);
        return true;
    }

    pauseActive(reason: string): void {
        const goal = this.activeGoal;
        if (!goal) return;
        goal.status = 'paused';
        this._pausedGoal = { ...goal };
        this._activeGoalId = null;
        console.log(`[GoalManager] Paused goal: ${goal.description} (${reason})`);
    }

    resumePaused(): boolean {
        if (!this._pausedGoal) return false;
        const id = this._pausedGoal.id;
        this._pausedGoal = null;
        return this.setActive(id);
    }

    complete(id: string): void {
        const goal = this._goals.get(id);
        if (!goal) return;
        goal.status = 'completed';
        goal.completedAt = Date.now();
        if (this._activeGoalId === id) this._activeGoalId = null;
        console.log(`[GoalManager] Completed goal: ${goal.description}`);
    }

    fail(id: string, reason: string): void {
        const goal = this._goals.get(id);
        if (!goal) return;
        goal.status = 'failed';
        goal.failReason = reason;
        goal.completedAt = Date.now();
        if (this._activeGoalId === id) this._activeGoalId = null;
        console.log(`[GoalManager] Failed goal: ${goal.description} — ${reason}`);
    }

    cancel(id: string): void {
        const goal = this._goals.get(id);
        if (!goal) return;
        goal.status = 'cancelled';
        if (this._activeGoalId === id) this._activeGoalId = null;
        console.log(`[GoalManager] Cancelled goal: ${goal.description}`);
    }

    selectNext(): Goal | null {
        const pending = this.pendingGoals;
        if (pending.length === 0) return null;
        const next = pending[0];
        this.setActive(next.id);
        return next;
    }

    addTaskToGoal(goalId: string, taskId: string): void {
        const goal = this._goals.get(goalId);
        if (goal) goal.taskIds.push(taskId);
    }

    generateIdleGoal(): Goal | null {
        const now = Date.now();
        if (now < this._autoGoalCooldown) return null;

        const idleGoalId = this.addGoal({
            type: 'autonomous',
            description: 'safe wander and gather',
            metadata: { auto: true, behavior: 'wander_gather' },
        });
        this._autoGoalCooldown = now + 60000;
        return this._goals.get(idleGoalId) ?? null;
    }

    cleanup(maxAgeMs = 3600000): void {
        const cutoff = Date.now() - maxAgeMs;
        for (const [id, goal] of this._goals) {
            const terminal = goal.status === 'completed' || goal.status === 'failed' || goal.status === 'cancelled';
            if (terminal && (goal.completedAt ?? 0) < cutoff) {
                this._goals.delete(id);
            }
        }
    }
}

import type { Goal, GoalPriority, GoalStatus } from '../types/index.js';
import type { SkillLibrary } from './skill-library.js';

export interface CurriculumRule {
    name: string;
    description: string;
    /** Priority order: lower = checked first */
    order: number;
    /** If this rule's conditions aren't met, generate its goals */
    check: (inventorySummary: string[], completedGoals: string[]) => boolean;
    /** Goals to generate when check returns false (goal not yet satisfied) */
    generate: () => Array<{
        type: GoalPriority;
        description: string;
        metadata?: Record<string, unknown>;
    }>;
}

export class GoalManager {
    private _goals: Map<string, Goal> = new Map();
    private _activeGoalId: string | null = null;
    private _pausedGoal: Goal | null = null;
    private _autoGoalCooldown = 0;
    private _curriculumRules: CurriculumRule[] = [];
    private _skillLib: SkillLibrary | null = null;

    setSkillLibrary(lib: SkillLibrary): void { this._skillLib = lib; }

    setCurriculumRules(rules: CurriculumRule[]): void { this._curriculumRules = rules; }

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
                const order: Record<string, number> = { survival: 0, user: 1, autonomous: 2, growth: 3 };
                return (order[a.type] ?? 9) - (order[b.type] ?? 9);
            });
    }

    get allGoals(): Goal[] {
        return Array.from(this._goals.values())
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    get completedGoalIds(): string[] {
        return Array.from(this._goals.values())
            .filter(g => g.status === 'completed')
            .map(g => g.id);
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
            progress: 0,
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
        goal.progress = 1;
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
        if (goal) {
            goal.taskIds.push(taskId);
        }
    }

    /** Update active goal progress and auto-complete if done */
    recordTaskProgress(goalId: string, current: number, target: number): void {
        const goal = this._goals.get(goalId);
        if (!goal) return;
        goal.progress = target > 0 ? Math.min(current / target, 1) : 0;
        if (goal.progress >= 1) {
            this.complete(goalId);
        }
    }

    /** Curriculum check: run all rules, generate goals for unmet ones */
    curriculumTick(inventorySummary: string[]): void {
        const sorted = [...this._curriculumRules].sort((a, b) => a.order - b.order);
        for (const rule of sorted) {
            const isSatisfied = rule.check(inventorySummary, this.completedGoalIds);
            if (isSatisfied) continue;

            const existing = Array.from(this._goals.values());
            const alreadyHas = existing.some(g =>
                g.status === 'pending' || g.status === 'active' &&
                g.description === rule.generate()[0]?.description
            );
            if (alreadyHas) continue;

            const generated = rule.generate();
            for (const g of generated) {
                if (!existing.some(eg => eg.description === g.description && eg.status !== 'failed' && eg.status !== 'cancelled')) {
                    this.addGoal(g);
                }
            }
        }
    }

    generateIdleGoal(): Goal | null {
        const now = Date.now();
        if (now < this._autoGoalCooldown) return null;

        // Check if there's still active goals to work on
        const active = this.activeGoal;
        if (active && active.status === 'active') return null;

        // Try to auto-select next pending goal
        const next = this.selectNext();
        if (next) return next;

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

/** Built-in curriculum rules for progressive skill acquisition */
export function createDefaultCurriculum(): CurriculumRule[] {
    return [
        {
            name: 'basic_survival',
            description: 'Ensure basic food and tools',
            order: 0,
            check: (inv) => {
                const hasPlanks = inv.some(i => i.includes('planks'));
                const hasFood = inv.some(i => ['cooked','steak','porkchop','bread','apple','potato','carrot'].some(f => i.includes(f)));
                return hasPlanks || hasFood;
            },
            generate: () => [
                { type: 'survival', description: 'collect wood for basic tools', metadata: { curriculum: 'basic_survival' } },
            ],
        },
        {
            name: 'wooden_pickaxe',
            description: 'Craft a wooden pickaxe for mining',
            order: 1,
            check: (inv) => inv.some(i => i.includes('wooden_pickaxe') || i.includes('stone_pickaxe') || i.includes('iron_pickaxe')),
            generate: () => [
                { type: 'growth', description: 'craft wooden pickaxe', metadata: { curriculum: 'tools' } },
            ],
        },
        {
            name: 'stone_pickaxe',
            description: 'Upgrade to stone pickaxe for better mining',
            order: 2,
            check: (inv) => inv.some(i => i.includes('stone_pickaxe') || i.includes('iron_pickaxe')),
            generate: () => [
                { type: 'growth', description: 'collect cobblestone and craft stone pickaxe', metadata: { curriculum: 'tools' } },
            ],
        },
        {
            name: 'furnace',
            description: 'Craft a furnace for smelting',
            order: 3,
            check: (inv) => inv.some(i => i.includes('furnace')),
            generate: () => [
                { type: 'growth', description: 'collect cobblestone and craft furnace', metadata: { curriculum: 'infrastructure' } },
            ],
        },
        {
            name: 'food_stockpile',
            description: 'Stockpile food for long operations',
            order: 4,
            check: (inv) => {
                const foodCount = inv.reduce((sum, i) => {
                    if (['cooked','steak','porkchop','bread','apple','potato','carrot'].some(f => i.includes(f))) {
                        const m = i.match(/x(\d+)/);
                        return sum + (m ? parseInt(m[1]) : 1);
                    }
                    return sum;
                }, 0);
                return foodCount >= 10;
            },
            generate: () => [
                { type: 'autonomous', description: 'gather food stockpile', metadata: { curriculum: 'sustenance' } },
            ],
        },
    ];
}

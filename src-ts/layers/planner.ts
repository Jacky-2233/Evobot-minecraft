/**
 * LLM Planner
 *
 * Takes a high-level goal, generates a Plan using the LLM,
 * executes steps through the executor, reflects on failures.
 * LLM is used for PLANNING only — not real-time action selection.
 */
import type { Bot } from 'mineflayer';
import type { Perception } from '../layers/perception.js';
import type { Memory } from '../layers/memory.js';
import type { Executor } from '../executor/executor.js';
import type {
    Plan,
    PlanStep,
    BotConfig,
    WorldStateSummary,
} from '../types/index.js';

export interface PlannerDeps {
    bot: Bot;
    perception: Perception;
    memory: Memory;
    executor: Executor;
    config: BotConfig;
    /** Submit a task through orchestrator (preserves id for result tracking) */
    submitTask?: (task: { id: string; type: string; params: Record<string, unknown>; priority: number; source: string; createdAt: number; expiresAt?: number }) => void;
}

export interface PlanResult {
    success: boolean;
    goal: string;
    stepsCompleted: number;
    totalSteps: number;
    detail: string;
}

export class Planner {
    private bot: Bot;
    private perception: Perception;
    private memory: Memory;
    private executor: Executor;
    private config: BotConfig;
    private _submitTask: ((task: { id: string; type: string; params: Record<string, unknown>; priority: number; source: string; createdAt: number; expiresAt?: number }) => void) | null = null;

    private _currentPlan: Plan | null = null;
    private _currentStepIndex = 0;
    private _running = false;

    /** Callback for LLM think output (prompt + response) */
    onThink: ((prompt: string, response: string) => void) | null = null;

    constructor(deps: PlannerDeps) {
        this.bot = deps.bot;
        this.perception = deps.perception;
        this.memory = deps.memory;
        this.executor = deps.executor;
        this.config = deps.config;
        this._submitTask = deps.submitTask ?? null;
    }

    get isRunning(): boolean {
        return this._running;
    }

    get currentPlan(): Plan | null {
        return this._currentPlan;
    }

    /** Start a new plan from a goal string */
    async planAndExecute(goal: string): Promise<PlanResult> {
        this._running = true;
        this._currentStepIndex = 0;

        console.log(`[Planner] Goal: "${goal}"`);

        // 1. Generate plan via LLM
        try {
            this._currentPlan = await this.generatePlan(goal);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Planner] Plan generation failed: ${msg}`);
            this._running = false;
            return {
                success: false,
                goal,
                stepsCompleted: 0,
                totalSteps: 0,
                detail: `Plan generation failed: ${msg}`,
            };
        }

        if (!this._currentPlan || this._currentPlan.steps.length === 0) {
            this._running = false;
            return {
                success: false,
                goal,
                stepsCompleted: 0,
                totalSteps: 0,
                detail: 'No actionable steps generated',
            };
        }

        console.log(`[Planner] Plan: ${this._currentPlan.steps.length} steps`);
        this._currentPlan.steps.forEach((s, i) => {
            console.log(`  ${i + 1}. ${s.skillName}(${JSON.stringify(s.params)})`);
        });

        this.memory.recordPlan(
            `Plan for "${goal}"`,
            { steps: this._currentPlan.steps.map((s) => s.skillName) },
        );

        // 2. Execute each step
        let completed = 0;
        for (let i = 0; i < this._currentPlan.steps.length; i++) {
            if (!this._running) break;

            this._currentStepIndex = i;
            const step = this._currentPlan.steps[i];
            console.log(`[Planner] Step ${i + 1}/${this._currentPlan.steps.length}: ${step.skillName}`);

            const result = await this.executeStep(step);

            if (!result.ok) {
                console.warn(`[Planner] Step ${i + 1} failed: ${result.detail}`);

                // Reflection → replan if needed
                const shouldReplan = step.onFailure === 'fallback' || step.onFailure === 'retry';
                if (shouldReplan && i < this._currentPlan.steps.length - 1) {
                    try {
                        const newPlan = await this.reflectAndReplan(
                            goal,
                            result.detail,
                            completed,
                        );
                        if (newPlan && newPlan.steps.length > 0) {
                            // Replace remaining steps
                            this._currentPlan.steps = [
                                ...this._currentPlan.steps.slice(0, i),
                                ...newPlan.steps,
                            ];
                            this._currentPlan.contingency = newPlan;
                            console.log(`[Planner] Replanned with ${newPlan.steps.length} new steps`);
                            continue;
                        }
                    } catch {
                        // Replan failed, continue with original plan
                    }
                }

                if (step.onFailure === 'skip') {
                    completed++; // count as attempted
                    continue;
                }
                if (step.onFailure === 'abort') {
                    break;
                }
                // 'retry' already handled above; if no replan, just stop
                break;
            }

            completed++;
        }

        this._running = false;
        const success = completed >= this._currentPlan.steps.length * 0.5;
        return {
            success,
            goal,
            stepsCompleted: completed,
            totalSteps: this._currentPlan.steps.length,
            detail: success
                ? `Completed ${completed}/${this._currentPlan.steps.length} steps`
                : `Only ${completed}/${this._currentPlan.steps.length} steps done`,
        };
    }

    cancel(): void {
        this._running = false;
        this.executor.clear();
        this.bot.pathfinder?.stop();
        this.bot.clearControlStates();
    }

    // ─── LLM Calls ───────────────────────────────────────

    private async generatePlan(goal: string): Promise<Plan> {
        const context = this.buildContext();
        const prompt = this.buildPlanPrompt(goal, context);

        const response = await this.callLLM([
            { role: 'system', content: this.getSystemPrompt() },
            { role: 'user', content: prompt },
        ]);

        return this.parsePlanResponse(response, goal);
    }

    private async reflectAndReplan(
        goal: string,
        failureDetail: string,
        completed: number,
    ): Promise<Plan | null> {
        const context = this.buildContext();
        const prompt =
            `Plan for "${goal}" failed at step ${completed + 1}: ${failureDetail}\n` +
            `Current world state:\n${context}\n\n` +
            `Generate an ALTERNATIVE plan to complete the remaining work. ` +
            `Output JSON with key "steps" (array of step objects).`;

        const response = await this.callLLM([
            { role: 'system', content: this.getSystemPrompt() },
            { role: 'user', content: prompt },
        ]);

        return this.parsePlanResponse(response, goal);
    }

    // ─── Step Execution ──────────────────────────────────

    private async executeStep(
        step: PlanStep,
    ): Promise<{ ok: boolean; detail: string }> {
        return new Promise((resolve) => {
            const id = `plan-${Date.now().toString(36)}`;
            const oldComplete = this.executor.onComplete;

            this.executor.onComplete = (tr) => {
                if (tr.task.id === id) {
                    this.executor.onComplete = oldComplete;
                    resolve({
                        ok: tr.result.ok,
                        detail: tr.result.detail,
                    });
                } else {
                    oldComplete?.(tr);
                }
            };

            const task = {
                id,
                type: step.skillName,
                params: step.params,
                priority: 5,
                source: 'planner' as const,
                createdAt: Date.now(),
                expiresAt: Date.now() + (step.timeoutMs || 60000),
            };

            if (this._submitTask) {
                this._submitTask(task);
            } else {
                this.executor.enqueue(task);
            }

            setTimeout(() => {
                resolve({ ok: false, detail: 'Step timeout' });
            }, step.timeoutMs || 60000);
        });
    }

    // ─── Context Building ────────────────────────────────

    private buildContext(): string {
        const s = this.perception.scan();
        const inv = this.bot.inventory.items();
        const inventoryStr = inv
            .slice(0, 10)
            .map((i) => `${i.name} x${i.count}`)
            .join(', ');

        const hostileStr = s.nearbyHostile
            .slice(0, 5)
            .map((e) => `${e.name}(${e.distance.toFixed(1)}m)`)
            .join(', ');

        const blockStr = s.nearbyBlocks
            .slice(0, 8)
            .map((b) => `${b.name} x${b.count}`)
            .join(', ');

        const memStr = this.memory.getContextWindow(10);

        return [
            `Time: ${s.timeOfDay} | HP: ${s.health.toFixed(0)} | Food: ${s.food.toFixed(0)}`,
            `Position: (${s.position.x.toFixed(1)}, ${s.position.y.toFixed(1)}, ${s.position.z.toFixed(1)})`,
            s.nearbyPlayers.length > 0
                ? `Players: ${s.nearbyPlayers.map((p) => p.name).join(', ')}`
                : 'Players: none',
            hostileStr ? `Hostile: ${hostileStr}` : 'Hostile: none',
            `Inventory: ${inventoryStr || 'empty'}`,
            `Nearby blocks: ${blockStr || 'none'}`,
            `Recent memory:\n${memStr}`,
        ].join('\n');
    }

    private buildPlanPrompt(goal: string, context: string): string {
        return [
            `Current world state:`,
            context,
            '',
            `Goal: ${goal}`,
            '',
            `Available skills: move_to, collect, eat.`,
            `Generate a step-by-step plan using these skills.`,
            `Each step must have: skillName, params, onFailure ("abort"|"retry"|"skip"|"fallback").`,
            `Params for move_to: { x, y, z, reachDistance? }`,
            `Params for collect: { target (block name), count?, maxDistance? }`,
            `Params for eat: {}`,
            '',
            `Output ONLY valid JSON: { "goal": "...", "steps": [...] }`,
            `Keep it concise. Max 5 steps.`,
        ].join('\n');
    }

    private getSystemPrompt(): string {
        return (
            `You are a Minecraft task planner for a bot named EvoBot. ` +
            `Your job is to convert a high-level goal into a sequence of skill calls. ` +
            `Available skills: move_to(x,y,z) — navigate, collect(target,count) — mine blocks, eat — consume food. ` +
            `Output ONLY valid JSON. No extra text.`
        );
    }

    private async callLLM(
        messages: { role: string; content: string }[],
    ): Promise<string> {
        const { callLLM: sharedCall } = await import('../utils/llm.js');
        const content = await sharedCall(messages, {
            maxTokens: this.config.ai.maxTokens,
            temperature: 0.5,
        });

        if (this.onThink) {
            const lastMsg = messages[messages.length - 1]?.content ?? '';
            this.onThink(lastMsg.slice(0, 1000), content.slice(0, 2000));
        }
        return content;
    }

    private parsePlanResponse(json: string, goal: string): Plan {
        // Strip markdown code fences
        let clean = json
            .replace(/```[\w]*\n?/g, '')
            .replace(/```/g, '')
            .trim();

        // Try extracting JSON object
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) clean = match[0];

        try {
            const parsed = JSON.parse(clean);
            const steps: PlanStep[] = (parsed.steps || []).map((s: any) => ({
                skillName: s.skillName || s.type || s.name || 'move_to',
                params: s.params || s.parameters || {},
                maxRetries: s.maxRetries ?? 1,
                timeoutMs: s.timeoutMs ?? 30000,
                onFailure: s.onFailure || 'abort',
            }));

            return { goal: parsed.goal || goal, steps };
        } catch {
            // Fallback: try to generate a simple default plan
            return {
                goal,
                steps: [
                    {
                        skillName: 'move_to',
                        params: { x: 0, y: 64, z: 0 },
                        maxRetries: 1,
                        timeoutMs: 15000,
                        onFailure: 'abort',
                    },
                ],
            };
        }
    }
}

/**
 * AI Commander — LLM-driven decision maker
 *
 * Runs every 5-15 seconds. Decides what the bot should do next.
 * Output is validated by Arbiter before execution.
 *
 * LLM role: strategic commander (WHAT to do)
 * Code role: tactical executor (HOW to do it safely)
 */

export interface CommanderInput {
    position: { x: number; y: number; z: number } | null;
    health: number;
    food: number;
    onGround: boolean;
    timeOfDay: string;
    inventory: string[];
    inventoryUsed: number;
    inventoryTotal: number;
    positionHealth: string;
    currentTask: string | null;
    currentBehavior: string | null;
    recentEvents: string[];
    recentFailures: string[];
    recentCompletions: string[];
    nearbyHostile: { name: string; distance: number }[];
    nearbyPlayers: { name: string; distance: number }[];
    nearbyBlocks: { name: string; count: number }[];
    gapFindings: { category: string; summary: string }[];
    uptimeMs: number;
    isReconnecting: boolean;
    memorySize: number;
}

export interface CommanderTask {
    type: string;
    params: Record<string, unknown>;
    priority: number;
}

export interface CommanderDecision {
    mode: 'continue' | 'switch_goal' | 'recover' | 'idle' | 'generate_spec';
    goal?: string;
    tasks: CommanderTask[];
    reason: string;
    riskLevel: 'low' | 'medium' | 'high';
    expectedDurationSec?: number;
}

export class Commander {
    private _lastDecision: CommanderDecision | null = null;
    private _lastDecisionTime = 0;
    private _cooldownMs = 5000;
    private _running = false;

    get lastDecision(): CommanderDecision | null { return this._lastDecision; }

    /** Decide what to do next */
    async decide(input: CommanderInput): Promise<CommanderDecision> {
        const prompt = this.buildPrompt(input);

        try {
            const { callLLM } = await import('../utils/llm.js');
            const response = await callLLM([
                {
                    role: 'system',
                    content:
                        'You are EvoBot Commander. Given the bot state, decide the next action.\n' +
                        'Output ONLY valid JSON with keys: mode, goal, tasks (array), reason, riskLevel.\n' +
                        `Available task types: move_to (x,y,z,reachDistance), collect (target,count,maxDistance), pickup, eat, retreat (distance).\n` +
                        `Modes:\n` +
                        `- "continue": keep doing current task\n` +
                        `- "switch_goal": start a new goal\n` +
                        `- "recover": health/food low or position invalid, need recovery\n` +
                        `- "idle": nothing useful to do\n` +
                        `- "generate_spec": enough gap data, generate skill spec\n` +
                        `Keep it concise. 1-3 tasks max. riskLevel: low/medium/high based on hostile or health risks.`,
                },
                { role: 'user', content: prompt },
            ], { maxTokens: 300, temperature: 0.7 });

            const decision = this.parseDecision(response);
            this._lastDecision = decision;
            this._lastDecisionTime = Date.now();
            return decision;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[Commander] LLM error: ${msg}`);
            return {
                mode: 'idle',
                reason: `LLM error: ${msg}`,
                tasks: [],
                riskLevel: 'low',
            };
        }
    }

    private buildPrompt(input: CommanderInput): string {
        const invStr = input.inventory.slice(0, 8).join(', ') || 'empty';
        const hostileStr = input.nearbyHostile.map(e => `${e.name}(${e.distance.toFixed(1)}m)`).join(', ') || 'none';
        const blockStr = input.nearbyBlocks.slice(0, 5).map(b => `${b.name} x${b.count}`).join(', ') || 'none';
        const failStr = input.recentFailures.slice(-3).join('; ') || 'none';
        const gapStr = input.gapFindings.slice(-2).map(g => `[${g.category}] ${g.summary}`).join('\n') || 'none';

        return [
            `--- Bot State ---`,
            `HP: ${input.health.toFixed(0)}/${input.food.toFixed(0)} | ${input.timeOfDay}`,
            `Pos: ${input.position ? `(${input.position.x.toFixed(0)},${input.position.y.toFixed(0)},${input.position.z.toFixed(0)})` : '?'}`,
            `PositionHealth: ${input.positionHealth}`,
            `OnGround: ${input.onGround} | Uptime: ${(input.uptimeMs / 60000).toFixed(0)}min`,
            `Inventory (${input.inventoryUsed}/${input.inventoryTotal}): ${invStr}`,
            `Hostile: ${hostileStr}`,
            `Nearby blocks: ${blockStr}`,
            `Current: ${input.currentTask ?? 'idle'} | Behavior: ${input.currentBehavior ?? 'none'}`,
            `Recent failures: ${failStr}`,
            `Recent completions: ${input.recentCompletions.slice(-2).join('; ') || 'none'}`,
            `Gap findings: ${gapStr}`,
            `Memory: ${input.memorySize} entries`,
            input.isReconnecting ? `⚠ Reconnecting...` : '',
            ``,
            `Decide what to do next. Output JSON.`,
        ].filter(l => l).join('\n');
    }

    private parseDecision(raw: string): CommanderDecision {
        let clean = raw.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) clean = match[0];
        try {
            const parsed = JSON.parse(clean);
            return {
                mode: parsed.mode || 'idle',
                goal: parsed.goal,
                tasks: (parsed.tasks || []).map((t: any) => ({
                    type: t.type || t.task || 'move_to',
                    params: t.params || {},
                    priority: t.priority ?? 30,
                })),
                reason: parsed.reason || 'No reason given',
                riskLevel: parsed.riskLevel || 'low',
                expectedDurationSec: parsed.expectedDurationSec,
            };
        } catch {
            return { mode: 'idle', reason: 'Failed to parse LLM response', tasks: [], riskLevel: 'low' };
        }
    }
}

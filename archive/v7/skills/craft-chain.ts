import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import type { SkillResult } from '../types/index.js';
import { CollectSkill } from './collect.js';
import { CraftSkill } from './craft.js';

type ChainStep =
    | { op: 'collect'; target: string; count: number }
    | { op: 'craft'; item: string; count: number };

// Recipes expressed as sequential operations.
// Crafting counts are recipe operations (e.g. 1 craft of planks consumes 1 log and yields 4 planks).
const CHAINS: Record<string, ChainStep[]> = {
    wooden_pickaxe: [
        { op: 'collect', target: 'log', count: 2 },
        { op: 'craft', item: 'planks', count: 2 }, // 2 logs -> 8 planks
        { op: 'craft', item: 'stick', count: 1 },  // 2 planks -> 4 sticks
        { op: 'craft', item: 'wooden_pickaxe', count: 1 },
    ],
    crafting_table: [
        { op: 'collect', target: 'log', count: 1 },
        { op: 'craft', item: 'planks', count: 1 }, // 1 log -> 4 planks
        { op: 'craft', item: 'crafting_table', count: 1 },
    ],
    stone_pickaxe: [
        { op: 'collect', target: 'log', count: 1 },
        { op: 'collect', target: 'stone', count: 3 },
        { op: 'craft', item: 'planks', count: 1 },
        { op: 'craft', item: 'stick', count: 1 },
        { op: 'craft', item: 'stone_pickaxe', count: 1 },
    ],
    sticks: [
        { op: 'collect', target: 'log', count: 1 },
        { op: 'craft', item: 'planks', count: 1 },
        { op: 'craft', item: 'stick', count: 1 },
    ],
    furnace: [
        { op: 'collect', target: 'stone', count: 8 },
        { op: 'craft', item: 'furnace', count: 1 },
    ],
};

export class CraftChainSkill extends BaseSkill<{ item: string }> {
    readonly name = 'craft_chain';
    readonly defaultTimeoutMs = 60000;
    constructor(private bot: Bot) { super(); }

    protected async _execute(params: { item: string }, signal: AbortSignal): Promise<SkillResult> {
        const chain = CHAINS[params.item];
        if (!chain) return this.result(false, `Unknown chain: ${params.item}`, 'not_possible');

        const collectSkill = new CollectSkill(this.bot);
        const craftSkill = new CraftSkill(this.bot);

        for (let i = 0; i < chain.length; i++) {
            if (signal.aborted) return this.result(false, 'Cancelled', 'cancelled');
            const step = chain[i];
            const label = step.op === 'collect' ? `${step.op} ${step.target} x${step.count}` : `${step.op} ${step.item} x${step.count}`;
            console.log(`[craft_chain] ${i + 1}/${chain.length}: ${label}`);

            const res = step.op === 'collect'
                ? await collectSkill.run({ target: step.target, count: step.count })
                : await craftSkill.run({ item: step.item, count: step.count });

            if (!res.ok) {
                return this.result(false, `Chain failed at ${label}: ${res.detail}`, res.failureType ?? 'internal_error');
            }
        }
        return this.result(true, `Crafted ${params.item}`);
    }
}

export function listCraftChains(): string {
    return Object.keys(CHAINS).join(', ');
}

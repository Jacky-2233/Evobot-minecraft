import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import type { SkillResult } from '../types/index.js';

const RECIPES: Record<string, { table: boolean; need: Record<string, number> }> = {
    planks: { table: false, need: { log: 1 } },
    stick: { table: false, need: { planks: 2 } },
    crafting_table: { table: false, need: { planks: 4 } },
    wooden_pickaxe: { table: true, need: { planks: 3, stick: 2 } },
    stone_pickaxe: { table: true, need: { cobblestone: 3, stick: 2 } },
    wooden_sword: { table: true, need: { planks: 2, stick: 1 } },
    furnace: { table: true, need: { cobblestone: 8 } },
};

function countItem(bot: Bot, name: string): number {
    return bot.inventory.items().reduce((s, i) => s + (((i as any).name ?? '').includes(name) ? i.count : 0), 0);
}

export class CraftSkill extends BaseSkill<{ item: string; count?: number }> {
    readonly name = 'craft';
    readonly defaultTimeoutMs = 20000;
    constructor(private bot: Bot) { super(); }

    protected async _execute(params: { item: string; count?: number }): Promise<SkillResult> {
        const item = params.item;
        const recipe = RECIPES[item];
        if (!recipe) return this.result(false, `Unknown recipe: ${item}`, 'not_possible');
        const cnt = params.count ?? 1;
        for (const [mat, need] of Object.entries(recipe.need)) {
            if (countItem(this.bot, mat) < need * cnt) return this.result(false, `Need ${mat} x${need * cnt}`, 'no_resource');
        }
        let table: any = null;
        if (recipe.table) {
            const tbl = this.bot.inventory.items().find(i => ((i as any).name ?? '').includes('crafting_table'));
            if (!tbl) return this.result(false, 'Need crafting table', 'no_resource');
            try {
                await this.bot.equip(tbl, 'hand');
                const below = this.bot.blockAt(this.bot.entity.position.floored().offset(0, -1, 0));
                if (below) await this.bot.placeBlock(below, new (require('vec3') as any)(0, 1, 0));
                const nearby = this.bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 4 });
                if (nearby) table = nearby;
            } catch {}
            if (!table) return this.result(false, 'Failed to place crafting table', 'internal_error');
        }
        try {
            const id = this.bot.registry?.itemsByName?.[item]?.id;
            if (!id) return this.result(false, `Unknown item: ${item}`, 'not_possible');
            const recipes = this.bot.recipesFor(id, 0, 1, table != null);
            if (!recipes?.length) return this.result(false, `No recipe for ${item}`, 'not_possible');
            await this.bot.craft(recipes[0], cnt, table ?? undefined);
            return this.result(true, `Crafted ${cnt}x ${item}`);
        } catch (err: unknown) {
            return this.result(false, err instanceof Error ? err.message : String(err), 'internal_error');
        }
    }
}

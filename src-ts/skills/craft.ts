import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import type { SkillResult, SkillContext } from '../types/index.js';

const RECIPES: Record<string, { needTable: boolean; materials: Record<string, number> }> = {
    planks:              { needTable: false, materials: { log: 1 } },
    stick:               { needTable: false, materials: { planks: 2 } },
    crafting_table:      { needTable: false, materials: { planks: 4 } },
    furnace:             { needTable: true,  materials: { cobblestone: 8 } },
    wooden_pickaxe:      { needTable: true,  materials: { planks: 3, stick: 2 } },
    stone_pickaxe:       { needTable: true,  materials: { cobblestone: 3, stick: 2 } },
    iron_pickaxe:        { needTable: true,  materials: { iron_ingot: 3, stick: 2 } },
    wooden_axe:          { needTable: true,  materials: { planks: 3, stick: 2 } },
    stone_axe:           { needTable: true,  materials: { cobblestone: 3, stick: 2 } },
    wooden_sword:        { needTable: true,  materials: { planks: 2, stick: 1 } },
    stone_sword:         { needTable: true,  materials: { cobblestone: 2, stick: 1 } },
};

function countItem(bot: Bot, name: string): number {
    return bot.inventory.items().reduce((sum, i) => {
        if (!i) return sum;
        const iname = (i as any).name ?? '';
        return iname.includes(name) ? sum + i.count : sum;
    }, 0);
}

function findItemSlot(bot: Bot, name: string): number | null {
    for (const item of bot.inventory.items()) {
        if (!item) continue;
        const iname = (item as any).name ?? '';
        if (iname.includes(name)) return item.slot;
    }
    return null;
}

export class CraftSkill extends BaseSkill<{ item: string; count?: number }> {
    readonly name = 'craft';
    readonly description = 'Craft tools and items from inventory.';
    readonly defaultTimeoutMs = 20000;
    readonly maxRetries = 1;

    private bot: Bot;

    constructor(bot: Bot) {
        super();
        this.bot = bot;
    }

    protected async _execute(
        params: { item: string; count?: number },
        ctx: SkillContext,
    ): Promise<SkillResult> {
        const itemName = params.item;
        const count = params.count ?? 1;
        const recipe = RECIPES[itemName];
        if (!recipe) {
            return this.result(false, `Unknown recipe: ${itemName}`, 'not_possible');
        }

        const matNames = Object.keys(recipe.materials);
        for (const mat of matNames) {
            const needed = recipe.materials[mat];
            const have = countItem(this.bot, mat);
            if (have < needed * count) {
                return this.result(false, `Missing ${mat}: need ${needed * count}, have ${have}`, 'no_resource');
            }
        }

        let craftingTable = null;
        if (recipe.needTable) {
            const existingTableSlot = findItemSlot(this.bot, 'crafting_table');
            if (!existingTableSlot) {
                return this.result(false, 'Need crafting table in inventory', 'no_resource');
            }
            const tableItem = this.bot.inventory.items().find(i => i?.slot === existingTableSlot);
            if (tableItem) {
                const pos = this.bot.entity.position.floored().offset(0, -1, 0);
                const blockBelow = this.bot.blockAt(pos);
                if (blockBelow) {
                    await this.bot.equip(tableItem, 'hand');
                    await this.bot.placeBlock(blockBelow, new (require('vec3') as any)(0, 1, 0)).catch(() => {});
                    const nearby = this.bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 4 });
                    if (nearby) craftingTable = nearby;
                }
            }
            if (!craftingTable) {
                return this.result(false, 'Failed to place crafting table', 'internal_error');
            }
        }

        try {
            const itemId = this.getItemId(itemName);
            if (!itemId) return this.result(false, `Unknown item type: ${itemName}`, 'not_possible');

            const recipes = this.bot.recipesFor(itemId, 0, 1, craftingTable != null);
            if (!recipes || recipes.length === 0) {
                return this.result(false, `No recipe available for ${itemName}`, 'not_possible');
            }

            await this.bot.craft(recipes[0], count, craftingTable ?? undefined);
            return this.result(true, `Crafted ${count}x ${itemName}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return this.result(false, `Craft failed: ${msg}`, 'internal_error');
        }
    }

    private getItemId(name: string): number | null {
        try {
            const mcData = require('minecraft-data')(this.bot.version);
            const item = mcData.itemsByName?.[name];
            return item?.id ?? null;
        } catch {
            return null;
        }
    }
}

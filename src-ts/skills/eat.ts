/**
 * Eat Skill
 *
 * Consumes food from inventory to restore hunger.
 * Used by safety layer when hunger drops below threshold.
 */
import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import type { SkillResult, SkillContext } from '../types/index.js';

export class EatSkill extends BaseSkill<Record<string, unknown>> {
    readonly name = 'eat';
    readonly description = 'Eat food to restore hunger.';
    readonly defaultTimeoutMs = 10000;
    readonly maxRetries = 1;

    private bot: Bot;

    constructor(bot: Bot) {
        super();
        this.bot = bot;
    }

    protected async _execute(
        _params: Record<string, unknown>,
        ctx: SkillContext,
    ): Promise<SkillResult> {
        const foodItem = this.bot.inventory
            .items()
            .find((i) =>
                i.name.includes('cooked') || i.name.includes('steak')
                || i.name.includes('porkchop') || i.name.includes('mutton')
                || i.name.includes('chicken') || i.name.includes('beef')
                || i.name.includes('rabbit') || i.name.includes('salmon')
                || i.name.includes('cod') || i.name.includes('bread')
                || i.name.includes('potato') || i.name.includes('carrot')
                || i.name.includes('apple'),
            );

        if (!foodItem) {
            return this.result(false, 'No food in inventory', 'no_resource');
        }

        try {
            await this.bot.equip(foodItem, 'hand');
            await this.bot.consume();
            return this.result(true, `Ate ${foodItem.name}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return this.result(false, `Eat failed: ${msg}`, 'internal_error');
        }
    }
}

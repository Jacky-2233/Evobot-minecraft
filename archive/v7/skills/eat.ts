import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import type { SkillResult } from '../types/index.js';

export class EatSkill extends BaseSkill<Record<string, unknown>> {
    readonly name = 'eat';
    readonly defaultTimeoutMs = 10000;
    constructor(private bot: Bot) { super(); }

    protected async _execute(): Promise<SkillResult> {
        const food = this.bot.inventory.items().find(i =>
            ['cooked','steak','porkchop','mutton','chicken','beef','rabbit','salmon','cod','bread','potato','carrot','apple']
                .some(s => (i as any).name?.includes(s)));
        if (!food) return this.result(false, 'No food', 'no_resource');
        try {
            await this.bot.equip(food, 'hand');
            await this.bot.consume();
            return this.result(true, `Ate ${(food as any).name}`);
        } catch (err: unknown) {
            return this.result(false, err instanceof Error ? err.message : String(err), 'internal_error');
        }
    }
}

import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import type { SkillResult } from '../types/index.js';

export interface CollectParams { target: string; count?: number; maxDistance?: number }

export class CollectSkill extends BaseSkill<CollectParams> {
    readonly name = 'collect';
    readonly defaultTimeoutMs = 15000;
    constructor(private bot: Bot) { super(); }

    protected async _execute(params: CollectParams, signal: AbortSignal): Promise<SkillResult> {
        const target = params.target;
        const count = params.count ?? 1;
        const maxDist = params.maxDistance ?? 10;
        signal.addEventListener('abort', () => { try { this.bot.pathfinder?.stop(); } catch {} });

        let collected = 0;
        for (let i = 0; i < count; i++) {
            if (signal.aborted) return this.result(false, 'Cancelled', 'cancelled');
            const block = this.bot.findBlock({
                matching: (b: any) => b?.name?.includes(target) ?? false,
                maxDistance: maxDist,
            });
            if (!block) return this.result(collected > 0, collected > 0 ? `Partial: ${collected}/${count}` : `No ${target} found`, 'target_lost');

            const pos = this.bot.entity.position;
            const dist = pos.distanceTo(block.position);
            if (dist > 4) {
                try { await this.bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals.GoalBlock)(block.position.x, block.position.y, block.position.z)); } catch {}
            }
            try { await this.bot.dig(block); } catch { continue; }
            collected++;
        }
        return this.result(true, `Collected ${collected}/${count} ${target}`);
    }
}

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
        const defaultMaxDistance = target.includes('log') || target.includes('ore') || target.includes('stone') ? 24 : 10;
        const maxDist = params.maxDistance ?? defaultMaxDistance;
        signal.addEventListener('abort', () => { try { this.bot.pathfinder?.stop(); } catch {} });

        let collected = 0;
        const beforeCount = this.countMatchingInventory(target);
        for (let i = 0; i < count; i++) {
            if (signal.aborted) return this.result(false, 'Cancelled', 'cancelled');
            const block = this.bot.findBlock({
                matching: (b: any) => b?.name?.includes(target) ?? false,
                maxDistance: maxDist,
            });
            if (!block) return this.result(collected > 0, collected > 0 ? `Partial: ${collected}/${count}` : `No ${target} found`, 'target_lost');

            const pos = this.bot.entity.position;
            const dist = pos.distanceTo(block.position);
            if (target.includes('log') || block.name.includes('log')) await this.equipBestAxe();
            if (target.includes('stone') || target.includes('ore') || block.name.includes('stone') || block.name.includes('ore')) await this.equipBestPickaxe();
            if (dist > 4) {
                try {
                    await this.bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals.GoalNear)(block.position.x, block.position.y, block.position.z, 2));
                } catch {}
            }
            try { await this.bot.dig(block); } catch { continue; }
            collected++;
        }
        const afterCount = this.countMatchingInventory(target);
        if (afterCount <= beforeCount && collected === 0) {
            return this.result(false, `Tried collecting ${target}, but inventory did not change`, 'target_lost');
        }
        return this.result(true, `Collected ${collected}/${count} ${target}; inventory delta=${afterCount - beforeCount}`);
    }

    private async equipBestAxe(): Promise<void> {
        const axes = this.bot.inventory.items().filter((item: any) => item.name.endsWith('_axe'));
        if (axes.length === 0) return;
        const order = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'];
        axes.sort((a: any, b: any) => order.indexOf(a.name) - order.indexOf(b.name));
        try { await this.bot.equip(axes[0], 'hand'); } catch {}
    }

    private async equipBestPickaxe(): Promise<void> {
        const picks = this.bot.inventory.items().filter((item: any) => item.name.endsWith('_pickaxe'));
        if (picks.length === 0) return;
        const order = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'];
        picks.sort((a: any, b: any) => order.indexOf(a.name) - order.indexOf(b.name));
        try { await this.bot.equip(picks[0], 'hand'); } catch {}
    }

    private countMatchingInventory(target: string): number {
        return this.bot.inventory.items().reduce((sum, item: any) => sum + (item.name.includes(target) ? item.count : 0), 0);
    }
}

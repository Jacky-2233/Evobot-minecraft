/**
 * Item Pickup Skill
 *
 * Scans for nearby dropped item entities, navigates to them,
 * and collects by proximity. Used by the gather behavior.
 */
import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import { SkillResult, SkillContext } from '../types/index.js';

export interface PickupParams {
    /** Max distance to scan for items */
    scanRadius?: number;
    /** Max number of items to pick up */
    maxItems?: number;
}

export class PickupSkill extends BaseSkill<PickupParams> {
    readonly name = 'pickup';
    readonly description = 'Pick up nearby dropped items.';
    readonly defaultTimeoutMs = 30000;
    readonly maxRetries = 1;

    private bot: Bot;

    constructor(bot: Bot) {
        super();
        this.bot = bot;
    }

    protected async _execute(
        params: PickupParams,
        ctx: SkillContext,
    ): Promise<SkillResult> {
        const { scanRadius = 8, maxItems = 10 } = params;
        let collected = 0;
        let attempts = 0;

        while (collected < maxItems && attempts < maxItems * 2) {
            if (ctx.signal.aborted) {
                return this.result(collected > 0, 'Cancelled', 'cancelled');
            }
            if (Date.now() > ctx.deadline) break;

            attempts++;

            const item = this.findNearestItem(scanRadius);
            if (!item) {
                if (collected > 0) {
                    return this.result(true, `Picked up ${collected} items`);
                }
                return this.result(false, 'No items nearby', 'target_lost');
            }

            // Move to item
            const reached = await this.navigateToItem(item);
            if (reached) {
                collected++;
                ctx.log('info', `Picked up item x${collected}`);
                await this.sleep(300); // Give server time to pick up
            }
        }

        if (collected > 0) {
            return this.result(true, `Picked up ${collected} items`);
        }
        return this.result(false, 'Failed to pick up items', 'timeout');
    }

    private findNearestItem(radius: number): any | null {
        if (!this.bot.entities) return null;
        const pos = this.bot.entity?.position;
        if (!pos) return null;

        let nearest: any = null;
        let minDist = Infinity;

        for (const [, entity] of Object.entries(this.bot.entities)) {
            if (!entity) continue;
            const name = (entity as any).name?.toLowerCase() ?? '';
            if (name !== 'item' && (entity as any).type !== 'object') continue;

            const ep = entity.position;
            if (Number.isNaN(ep.x) || Number.isNaN(ep.y) || Number.isNaN(ep.z)) continue;

            const dist = pos.distanceTo(ep);
            if (dist <= radius && dist < minDist) {
                minDist = dist;
                nearest = entity;
            }
        }

        return nearest;
    }

    private async navigateToItem(item: any): Promise<boolean> {
        // Don't pick up if inventory is (nearly) full
        if (this.bot.inventory.emptySlotCount() <= 1) {
            return false;
        }

        const pos = item.position;
        const bp = this.bot.entity.position;

        // If very close, just walk toward it
        if (pos.distanceTo(bp) < 1) {
            this.bot.lookAt(pos);
            await this.sleep(500);
            return true;
        }

        // Use pathfinder to navigate
        try {
            const { GoalNear } = require('mineflayer-pathfinder').goals;
            const goal = new GoalNear(pos.x, pos.y, pos.z, 1);
            await this.bot.pathfinder.goto(goal);
            await this.sleep(200);
            return true;
        } catch {
            this.bot.pathfinder.stop();
            return false;
        }
    }
}

/**
 * Collect Block Skill
 *
 * Mines a specific block type up to target_count.
 * Includes block-at-NaN detection, tool equip, dig.
 */
import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import { SkillResult, SkillContext } from '../types/index.js';
import {
    chooseDigStance,
    validateCurrentStanceForDig,
    type DigStancePlannerConfig,
} from './dig/dig-stance-planner.js';

export interface CollectParams {
    target: string;
    count?: number;
    maxDistance?: number;
}

export class CollectSkill extends BaseSkill<CollectParams> {
    readonly name = 'collect';
    readonly description = 'Collect/gather a specific block type.';
    readonly defaultTimeoutMs = 60000;
    readonly maxRetries = 1;

    private bot: Bot;

    constructor(bot: Bot) {
        super();
        this.bot = bot;
    }

    protected async _execute(
        params: CollectParams,
        ctx: SkillContext,
    ): Promise<SkillResult> {
        const { target, count = 1, maxDistance = 30 } = params;
        let collected = 0;
        let attempts = 0;

        while (collected < count && attempts < count * 3) {
            if (ctx.signal.aborted) {
                return this.result(false, 'Cancelled', 'cancelled');
            }
            if (Date.now() > ctx.deadline) {
                break;
            }

            attempts++;
            const block = this.findNearestBlock(target, maxDistance);
            if (!block) {
                return this.result(collected > 0, `Only found ${collected}/${count} ${target}`, 'target_lost');
            }

            const bp = block.position;
            if (Number.isNaN(bp.x) || Number.isNaN(bp.y) || Number.isNaN(bp.z)) {
                ctx.log('warn', `Block position is NaN, skipping`);
                continue;
            }

            // Move close to block
            const moved = await this.moveToBlock(block);
            if (!moved) continue;

            // ─── Dig stance planning ───────────────────────
            const stanceResult = chooseDigStance(this.bot, block, {
                allowLeafFooting: false,
                maxBotToStanceDistance: 6,
            });

            if (stanceResult.ok && stanceResult.stance) {
                const stancePos = stanceResult.stance.position;
                const botPos = this.bot.entity.position.floored();
                // If optimal stance is different from current, move there
                if (botPos.x !== stancePos.x || botPos.y !== stancePos.y || botPos.z !== stancePos.z) {
                    ctx.log('info', `Moving to dig stance (${stancePos.x},${stancePos.y},${stancePos.z}) score=${stanceResult.stance.score}`);
                    await this.moveToPos(stancePos);
                }
            } else {
                ctx.log('warn', `No good dig stance: ${stanceResult.reason ?? 'unknown'}`);
            }

            // Validate stance before dig
            const validated = validateCurrentStanceForDig(this.bot, block, {
                allowLeafFooting: false,
            });
            if (!validated.ok) {
                ctx.log('warn', `Dig stance invalid: ${validated.reason}`);
                continue;
            }

            // Equip and dig
            try {
                await this.equipTool(block);
                this.bot.lookAt(bp.offset(0.5, 0.5, 0.5));
                await this.digWithRetry(block, 3);
                collected++;
                ctx.log('info', `Collected ${target} ${collected}/${count}`);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                ctx.log('warn', `Dig error: ${msg}`);
            }
        }

        if (collected >= count) {
            return this.result(true, `Collected ${collected}/${count} ${target}`);
        }
        return this.result(collected > 0, `Partial: ${collected}/${count} ${target}`, 'timeout');
    }

    private findNearestBlock(name: string, maxDist: number): any {
        const entityPos = this.bot.entity.position;
        if (!entityPos || typeof (entityPos as any).floored !== 'function') return null;
        const pos = entityPos.floored();
        let nearest: any = null;
        let minDist = Infinity;

        for (let dx = -maxDist; dx <= maxDist; dx++) {
            for (let dy = -maxDist; dy <= maxDist; dy++) {
                for (let dz = -maxDist; dz <= maxDist; dz++) {
                    const block = this.bot.blockAt(pos.offset(dx, dy, dz));
                    if (!block || block.name === 'air') continue;
                    if (!block.name.includes(name)) continue;
                    const dist = pos.distanceTo(block.position);
                    if (dist < minDist) {
                        minDist = dist;
                        nearest = block;
                    }
                }
            }
        }
        return nearest;
    }

    private async moveToBlock(block: any): Promise<boolean> {
        try {
            const { GoalNear } = require('mineflayer-pathfinder').goals;
            const goal = new GoalNear(
                block.position.x,
                block.position.y,
                block.position.z,
                1,
            );
            await this.bot.pathfinder.goto(goal);
            return true;
        } catch {
            this.bot.pathfinder.stop();
            return false;
        }
    }

    private async moveToPos(pos: { x: number; y: number; z: number }): Promise<boolean> {
        try {
            const { GoalBlock } = require('mineflayer-pathfinder').goals;
            const goal = new GoalBlock(pos.x, pos.y, pos.z);
            await this.bot.pathfinder.goto(goal);
            return true;
        } catch {
            this.bot.pathfinder.stop();
            return false;
        }
    }

    private async equipTool(block: any): Promise<void> {
        try {
            await this.bot.equip(block, 'hand');
        } catch {
            // Try manual tool find
            const toolTypes: Record<string, string[]> = {
                pickaxe: ['_ore', 'stone', 'cobblestone', 'deepslate'],
                axe: ['log', 'wood', 'planks'],
                shovel: ['dirt', 'gravel', 'sand'],
            };
            for (const [toolType, patterns] of Object.entries(toolTypes)) {
                if (patterns.some((p) => block.name.includes(p))) {
                    const tool = this.bot.inventory
                        .items()
                        .find((i) => i.name.includes(toolType));
                    if (tool) {
                        await this.bot.equip(tool, 'hand').catch(() => {});
                    }
                    break;
                }
            }
        }
    }

    private async digWithRetry(block: any, maxTries: number): Promise<void> {
        for (let i = 0; i < maxTries; i++) {
            const bp = block.position;
            if (Number.isNaN(bp.x) || Number.isNaN(bp.y) || Number.isNaN(bp.z)) {
                throw new Error('Block position became NaN');
            }
            await this.bot.dig(block);
            const check = this.bot.blockAt(bp);
            if (!check || check.name !== block.name) return;
            await this.sleep(200);
        }
    }
}

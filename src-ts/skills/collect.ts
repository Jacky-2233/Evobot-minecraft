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
        let consecutiveFailReasons: string[] = [];

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
            if (!moved) {
                consecutiveFailReasons.push('move_failed');
                continue;
            }

            // ─── Dig stance planning ───────────────────────
            const stanceResult = chooseDigStance(this.bot, block, {
                allowLeafFooting: false,
                maxBotToStanceDistance: 6,
            });

            if (stanceResult.ok && stanceResult.stance) {
                const stancePos = stanceResult.stance.position;
                const botPos = this.bot.entity.position.floored();
                const currentFooting = this.bot.blockAt(botPos.offset(0, -1, 0));
                const botOnLeaves = currentFooting?.name?.includes('leaves') ?? false;

                // If optimal stance differs from current, move there
                if (botPos.x !== stancePos.x || botPos.y !== stancePos.y || botPos.z !== stancePos.z) {
                    // Special log: if bot is on leaves and stance is solid, mention it
                    if (botOnLeaves && stanceResult.stance.stableFooting) {
                        ctx.log('info', `Moving off leaves to solid stance (${stancePos.x},${stancePos.y},${stancePos.z}) score=${stanceResult.stance.score}`);
                    } else {
                        ctx.log('info', `Moving to dig stance (${stancePos.x},${stancePos.y},${stancePos.z}) score=${stanceResult.stance.score}`);
                    }
                    const stanceMoved = await this.moveToPos(stancePos);
                    if (!stanceMoved) {
                        ctx.log('warn', `Failed to move to dig stance at (${stancePos.x},${stancePos.y},${stancePos.z})`);
                        consecutiveFailReasons.push('stance_move_failed');
                        continue;
                    }
                } else {
                    ctx.log('info', `Already at optimal dig stance`);
                }
            } else {
                const reason = stanceResult.reason ?? 'unknown';
                ctx.log('warn', `No good dig stance: ${reason}`);
                consecutiveFailReasons.push(`stance_${reason}`);

                // Handle specific failure cases
                if (reason === 'target_under_feet') {
                    // Target is directly under bot's feet — try moving 1 block to the side
                    ctx.log('info', 'Target under feet, moving aside');
                    const sidePos = this.bot.entity.position.floored().offset(1, 0, 0);
                    await this.moveToPos(sidePos);
                    continue;
                }
                if (reason === 'unsafe_footing' && (block.name?.includes('log') || block.name?.includes('wood'))) {
                    // Target is a log but footing is unsafe (likely on leaves)
                    ctx.log('info', 'Log in tree crown — trying lower stance');
                    // Try to find lower ground by moving down
                    const curPos = this.bot.entity.position.floored();
                    const lowerPos = { x: curPos.x, y: curPos.y - 2, z: curPos.z };
                    const lowerFooting = this.bot.blockAt(lowerPos as any);
                    if (lowerFooting && lowerFooting.name !== 'air') {
                        await this.moveToPos(lowerPos);
                        continue;
                    }
                }
                if (consecutiveFailReasons.length >= 3) {
                    // Too many stance failures — abort this block
                    ctx.log('warn', `Too many stance failures for ${target}, moving on`);
                    consecutiveFailReasons = [];
                    continue;
                }
                continue; // Try next block
            }

            // Validate stance before dig
            const validated = validateCurrentStanceForDig(this.bot, block, {
                allowLeafFooting: false,
            });
            if (!validated.ok) {
                ctx.log('warn', `Dig stance invalid: ${validated.reason}`);
                consecutiveFailReasons.push(`validate_${validated.reason}`);
                continue;
            }

            // Equip and dig
            try {
                await this.equipTool(block);
                this.bot.lookAt(bp.offset(0.5, 0.5, 0.5));
                await this.digWithRetry(block, 3);
                collected++;
                consecutiveFailReasons = [];
                ctx.log('info', `Collected ${target} ${collected}/${count}`);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                ctx.log('warn', `Dig error: ${msg}`);
                consecutiveFailReasons.push(`dig_${msg.slice(0, 20)}`);
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

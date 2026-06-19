/**
 * Collect Block Skill (Step-Based)
 *
 * Mines a specific block type using atomic steps.
 * Each step completes in <5s for 8-second connection windows.
 * Checkpoints are saved after each step for resume on disconnect.
 */
import type { Bot } from 'mineflayer';
import type {
    StepDefinition,
    StepSequence,
    StepResult,
    Vec3,
} from '../types/index.js';
import { createStep, createStepSequence } from '../types/index.js';

export interface CollectStepParams {
    target: string;
    count?: number;
    maxDistance?: number;
}

/**
 * Create a step sequence for collecting blocks.
 * Each step is atomic and completes in <5s.
 */
export function createCollectSteps(
    bot: Bot,
    target: string,
    count: number = 1,
    maxDistance: number = 10,
): StepSequence {
    const steps: StepDefinition[] = [];

    // Generate steps for each block we need to collect
    for (let i = 0; i < count; i++) {
        // Step 1: Scan for target blocks
        steps.push(createStep(
            `scan_${i}`,
            `Scan for ${target} (${i + 1}/${count})`,
            'scan',
            async (ctx) => {
                const blocks = findNearestBlocks(ctx.bot, target, maxDistance);
                if (blocks.length === 0) {
                    return {
                        ok: false,
                        detail: `No ${target} blocks found within ${maxDistance} blocks`,
                        failureType: 'target_lost',
                    };
                }
                return {
                    ok: true,
                    state: { [`foundBlocks_${i}`]: blocks.map(b => ({ x: b.position.x, y: b.position.y, z: b.position.z })) },
                    detail: `Found ${blocks.length} ${target} blocks`,
                };
            },
            2000,
            false,
        ));

        // Step 2: Select nearest block
        steps.push(createStep(
            `select_${i}`,
            `Select nearest ${target} block (${i + 1}/${count})`,
            'select',
            async (ctx) => {
                const blocks = ctx.state[`foundBlocks_${i}`] as Vec3[];
                if (!blocks || blocks.length === 0) {
                    return {
                        ok: false,
                        detail: 'No blocks found to select',
                        failureType: 'no_resource',
                    };
                }
                const botPos = ctx.bot.entity.position;
                const nearest = blocks
                    .map(b => ({ pos: b, dist: botPos.distanceTo(b) }))
                    .sort((a, b) => a.dist - b.dist)[0];
                return {
                    ok: true,
                    state: { [`selectedBlock_${i}`]: nearest.pos },
                    detail: `Selected block at ${nearest.pos.x},${nearest.pos.y},${nearest.pos.z}`,
                };
            },
            1000,
            false,
            [`scan_${i}`],
        ));

        // Step 3: Move to block
        steps.push(createStep(
            `move_${i}`,
            `Move to ${target} block (${i + 1}/${count})`,
            'move',
            async (ctx) => {
                const target = ctx.state[`selectedBlock_${i}`] as Vec3;
                if (!target) {
                    return {
                        ok: false,
                        detail: 'No target block selected',
                        failureType: 'internal_error',
                    };
                }
                const reached = await moveToPos(ctx.bot, target);
                return {
                    ok: reached,
                    detail: reached ? 'Reached block' : 'Failed to reach block',
                    failureType: reached ? undefined : 'path_stuck',
                };
            },
            5000,
            false,
            [`select_${i}`],
        ));

        // Step 4: Dig block
        steps.push(createStep(
            `dig_${i}`,
            `Dig ${target} block (${i + 1}/${count})`,
            'interact',
            async (ctx) => {
                const target = ctx.state[`selectedBlock_${i}`] as Vec3;
                const block = ctx.bot.blockAt(target);
                if (!block || block.name === 'air') {
                    return {
                        ok: false,
                        detail: 'Block not found or is air',
                        failureType: 'target_lost',
                    };
                }
                try {
                    await ctx.bot.dig(block);
                    return {
                        ok: true,
                        state: { [`collected_${i}`]: true },
                        detail: `Dug ${target} block`,
                    };
                } catch (err) {
                    return {
                        ok: false,
                        detail: err instanceof Error ? err.message : String(err),
                        failureType: 'internal_error',
                    };
                }
            },
            3000,
            false,
            [`move_${i}`],
        ));
    }

    // Step 5: Final validation
    steps.push(createStep(
        'validate_all',
        `Validate all ${count} blocks collected`,
        'validate',
        async (ctx) => {
            let collected = 0;
            for (let i = 0; i < count; i++) {
                if (ctx.state[`collected_${i}`]) {
                    collected++;
                }
            }
            return {
                ok: collected >= count,
                detail: collected >= count
                    ? `Successfully collected ${collected}/${count} ${target}`
                    : `Only collected ${collected}/${count} ${target}`,
                state: { totalCollected: collected },
            };
        },
        1000,
        false,
        steps.map(s => s.id),
    ));

    const sequence = createStepSequence(
        `collect_${target}_${Date.now()}`,
        `collect_${target}`,
        steps,
        { target, count, maxDistance },
    );

    sequence.originalTaskType = 'collect';
    sequence.originalTaskParams = { target, count, maxDistance };

    return sequence;
}

/** Find nearest blocks of a given type */
function findNearestBlocks(bot: Bot, name: string, maxDist: number): any[] {
    const entityPos = bot.entity.position;
    if (!entityPos || typeof (entityPos as any).floored !== 'function') return [];
    const pos = entityPos.floored();
    const blocks: any[] = [];

    for (let dx = -maxDist; dx <= maxDist; dx++) {
        for (let dy = -maxDist; dy <= maxDist; dy++) {
            for (let dz = -maxDist; dz <= maxDist; dz++) {
                const block = bot.blockAt(pos.offset(dx, dy, dz));
                if (!block || block.name === 'air') continue;
                if (!block.name.includes(name)) continue;
                blocks.push(block);
            }
        }
    }

    // Sort by distance
    blocks.sort((a, b) => pos.distanceTo(a.position) - pos.distanceTo(b.position));
    return blocks;
}

/** Move to a position using pathfinder */
async function moveToPos(bot: Bot, pos: Vec3): Promise<boolean> {
    try {
        const { GoalNear } = require('mineflayer-pathfinder').goals;
        const goal = new GoalNear(pos.x, pos.y, pos.z, 1);
        await bot.pathfinder.goto(goal);
        return true;
    } catch {
        bot.pathfinder.stop();
        return false;
    }
}

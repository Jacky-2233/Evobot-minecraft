/**
 * Movement Skill
 *
 * Wraps mineflayer-pathfinder with safety: NaN check, stuck guard, pathfinding.
 */
import type { Bot } from 'mineflayer';
import path from 'path';
import { BaseSkill } from './base.js';
import { SkillResult, SkillContext, Vec3 } from '../types/index.js';
import { nanTracer } from '../utils/nan-guard.js';

// Dynamic import for mineflayer-pathfinder (CJS module in ESM context)
let GoalNear: any;
let Movements: any;
try {
    const pf = require('mineflayer-pathfinder');
    GoalNear = pf.goals.GoalNear;
    Movements = pf.Movements;
} catch {
    // will be lazy-loaded on first execute
}

export interface MoveParams {
    x: number;
    y: number;
    z: number;
    reachDistance?: number;
    timeoutMs?: number;
}

export class MoveToSkill extends BaseSkill<MoveParams> {
    readonly name = 'move_to';
    readonly description = 'Navigate to a target coordinate.';
    readonly defaultTimeoutMs = 15000;
    readonly maxRetries = 1;

    private bot: Bot;

    constructor(bot: Bot) {
        super();
        this.bot = bot;
    }

    protected async _execute(
        params: MoveParams,
        ctx: SkillContext,
    ): Promise<SkillResult> {
        const { x, y, z, reachDistance = 1 } = params;

        // NaN guard
        if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
            return this.result(false, 'Target coordinates are NaN', 'not_possible');
        }
        const pos = this.bot.entity.position;
        if (Number.isNaN(pos.x) || Number.isNaN(pos.y) || Number.isNaN(pos.z)) {
            return this.result(false, 'Bot position is NaN — need reconnect', 'internal_error');
        }

        // Load pathfinder movements once
        if (!GoalNear || !Movements) {
            const pf = require('mineflayer-pathfinder');
            GoalNear = pf.goals.GoalNear;
            Movements = pf.Movements;
        }

        const mcData = require('minecraft-data')(this.bot.version);
        const moves = new Movements(this.bot, mcData);
        moves.canDig = false;
        this.bot.pathfinder.setMovements(moves);

        const goal = new GoalNear(x, y, z, reachDistance);
        nanTracer.trace('move_to.setGoal', { x, y, z, pos: this.bot.entity.position });

        return new Promise<SkillResult>((resolve) => {
            const onDone = () => {
                cleanup();
                resolve(this.result(true, `Reached (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`));
            };
            const onError = (err: Error) => {
                cleanup();
                resolve(this.result(false, err.message, 'path_stuck'));
            };
            const cleanup = () => {
                this.bot.removeListener('goal_reached', onDone);
                this.bot.removeListener('path_update', onStalled);
            };

            // Stalled detection
            let lastPos = pos.clone();
            const onStalled = () => {
                const d = this.bot.entity.position.distanceTo(lastPos);
                if (d > 0.3) lastPos = this.bot.entity.position.clone();
            };

            // Timeout (ctx.deadline)
            const deadlineTimer = setInterval(() => {
                if (Date.now() > ctx.deadline) {
                    cleanup();
                    this.bot.pathfinder.stop();
                    this.bot.clearControlStates();
                    resolve(this.result(false, 'Movement timeout', 'timeout'));
                }
            }, 500);

            // Check for NaN during movement
            const nanChecker = setInterval(() => {
                const p = this.bot.entity.position;
                if (Number.isNaN(p.x) || Number.isNaN(p.y) || Number.isNaN(p.z)) {
                    cleanup();
                    clearInterval(deadlineTimer);
                    this.bot.pathfinder.stop();
                    resolve(this.result(false, 'Got NaN during movement', 'internal_error'));
                }
            }, 300);

            this.bot.once('goal_reached', onDone);
            this.bot.on('path_update', onStalled);

            this.bot.pathfinder.goto(goal as any).catch((err: Error) => {
                onError(err);
            });

            // Also handle abort signal
            ctx.signal.addEventListener(
                'abort',
                () => {
                    cleanup();
                    clearInterval(deadlineTimer);
                    clearInterval(nanChecker);
                    this.bot.pathfinder.stop();
                    this.bot.clearControlStates();
                    resolve(this.result(false, 'Cancelled', 'cancelled'));
                },
                { once: true },
            );
        });
    }
}

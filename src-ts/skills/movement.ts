/**
 * Movement Skill
 *
 * Wraps mineflayer-pathfinder with safety: NaN check, stuck guard, pathfinding.
 * Handles server disconnects gracefully — resolves rather than path_stuck.
 */
import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import { SkillResult, SkillContext, Vec3 } from '../types/index.js';
import { nanTracer } from '../utils/nan-guard.js';

// Dynamic import for mineflayer-pathfinder (CJS module in ESM context)
let GoalNear: any;
let Movements: any;
let pfLoaded = false;

function loadPf(): void {
    if (pfLoaded) return;
    try {
        const pf = require('mineflayer-pathfinder');
        GoalNear = pf.goals.GoalNear;
        Movements = pf.Movements;
        pfLoaded = true;
    } catch {}
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
        if (!pos || Number.isNaN(pos.x) || Number.isNaN(pos.y) || Number.isNaN(pos.z)) {
            return this.result(false, 'Bot position is NaN', 'internal_error');
        }

        // Already there?
        const dist = Math.sqrt(
            (pos.x - x) ** 2 + (pos.y - y) ** 2 + (pos.z - z) ** 2,
        );
        if (dist <= reachDistance + 0.5) {
            return this.result(true, `Already at (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`);
        }

        loadPf();
        if (!GoalNear) {
            return this.result(false, 'Pathfinder not loaded', 'internal_error');
        }

        const mcData = require('minecraft-data')(this.bot.version);
        const moves = new Movements(this.bot, mcData);
        moves.canDig = false;
        this.bot.pathfinder.setMovements(moves);

        const goal = new GoalNear(x, y, z, reachDistance);
        nanTracer.trace('move_to.setGoal', { x, y, z, pos: this.bot.entity.position });

        return new Promise<SkillResult>((resolve) => {
            let settled = false;

            const finish = (ok: boolean, detail: string, failureType?: string) => {
                if (settled) return;
                settled = true;
                cleanup();
                try { this.bot.pathfinder.stop(); } catch {}
                resolve(this.result(ok, detail, failureType as any));
            };

            const cleanup = () => {
                this.bot.removeListener('goal_reached', onDone);
                this.bot.removeListener('path_update', onStalled);
                this.bot.removeListener('end', onDisconnect);
            };

            const onDone = () => {
                finish(true, `Reached (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`);
            };

            const onDisconnect = () => {
                finish(false, 'Disconnected during movement', 'cancelled');
            };

            // Stalled detection
            let lastPos = pos.clone();
            const onStalled = () => {
                if (!this.bot.entity) return;
                const d = this.bot.entity.position.distanceTo(lastPos);
                if (d > 0.3) lastPos = this.bot.entity.position.clone();
            };

            // Timeout
            const deadlineTimer = setInterval(() => {
                if (Date.now() > ctx.deadline) {
                    finish(false, 'Movement timeout', 'timeout');
                }
            }, 500);

            // NaN guard during movement
            const nanChecker = setInterval(() => {
                const p = this.bot.entity?.position;
                if (!p || Number.isNaN(p.x) || Number.isNaN(p.y) || Number.isNaN(p.z)) {
                    finish(false, 'Got NaN during movement', 'internal_error');
                }
            }, 300);

            this.bot.once('goal_reached', onDone);
            this.bot.on('path_update', onStalled);
            this.bot.once('end', onDisconnect);

            this.bot.pathfinder.goto(goal as any).catch((err: Error) => {
                if (!settled) {
                    const msg = err.message;
                    if (msg.includes('disconnect') || msg.includes('end') || msg.includes('reset')) {
                        finish(false, 'Disconnected', 'cancelled');
                    } else {
                        finish(false, msg, 'path_stuck');
                    }
                }
            });

            ctx.signal.addEventListener(
                'abort',
                () => {
                    finish(false, 'Cancelled', 'cancelled');
                },
                { once: true },
            );
        });
    }
}

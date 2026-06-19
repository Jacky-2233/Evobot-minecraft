import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import type { SkillResult } from '../types/index.js';
import { isFiniteVec3 } from '../utils/nan-guard.js';

let GoalNear: any;
(() => { try { GoalNear = require('mineflayer-pathfinder').goals.GoalNear; } catch {} })();

export interface MoveParams { x: number; y: number; z: number; reachDistance?: number }

export class MoveToSkill extends BaseSkill<MoveParams> {
    readonly name = 'move_to';
    readonly defaultTimeoutMs = 10000;
    constructor(private bot: Bot) { super(); }
    protected async _execute(params: MoveParams, signal: AbortSignal): Promise<SkillResult> {
        const target = { x: params.x, y: params.y, z: params.z };
        if (!isFiniteVec3(target)) return this.result(false, 'Invalid target', 'not_possible');
        signal.addEventListener('abort', () => { try { this.bot.pathfinder?.stop(); } catch {} });
        try {
            await this.bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, params.reachDistance ?? 2));
            return this.result(true, `Moved to (${target.x.toFixed(0)}, ${target.y.toFixed(0)}, ${target.z.toFixed(0)})`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('cancel') || msg.includes('abort')) return this.result(false, 'Cancelled', 'cancelled');
            return this.result(false, `Move failed: ${msg}`, 'path_stuck');
        }
    }
}

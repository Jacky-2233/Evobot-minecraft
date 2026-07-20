import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import type { SkillResult } from '../types/index.js';
import { isFiniteVec3 } from '../utils/nan-guard.js';

let GoalNear: any = null;
function ensureGoalNear(): boolean {
    if (GoalNear) return true;
    try {
        const pf = require('mineflayer-pathfinder');
        GoalNear = pf.goals?.GoalNear;
        if (!GoalNear) {
            console.error('[move_to] GoalNear not found in mineflayer-pathfinder');
            return false;
        }
        return true;
    } catch (e) {
        console.error('[move_to] Failed to load GoalNear:', (e as Error).message);
        return false;
    }
}

export interface MoveParams { x: number; y: number; z: number; reachDistance?: number }

export class MoveToSkill extends BaseSkill<MoveParams> {
    readonly name = 'move_to';
    readonly defaultTimeoutMs = 10000;
    constructor(private bot: Bot) { super(); }

    protected async _execute(params: MoveParams, signal: AbortSignal): Promise<SkillResult> {
        if (!ensureGoalNear()) return this.result(false, 'Pathfinder plugin not available', 'internal_error');
        const target = { x: params.x, y: params.y, z: params.z };
        if (!isFiniteVec3(target)) return this.result(false, 'Invalid target coordinates', 'not_possible');
        signal.addEventListener('abort', () => { try { this.bot.pathfinder?.stop(); } catch {} });
        try {
            console.log(`[move_to] Going to (${target.x.toFixed(0)}, ${target.y.toFixed(0)}, ${target.z.toFixed(0)})`);
            await this.bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, params.reachDistance ?? 2));
            return this.result(true, `Arrived at (${target.x.toFixed(0)}, ${target.y.toFixed(0)}, ${target.z.toFixed(0)})`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('cancel') || msg.includes('abort')) return this.result(false, 'Cancelled', 'cancelled');
            console.error(`[move_to] Failed: ${msg}`);
            return this.result(false, msg, 'path_stuck');
        }
    }
}

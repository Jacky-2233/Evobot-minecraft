/**
 * Combat Skill — Retreat when attacked
 *
 * Real-time damage response: on taking damage, check for nearby
 * hostiles and retreat immediately. Also supports basic attack.
 */
import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import { SkillResult, SkillContext } from '../types/index.js';
import { nanTracer, isFiniteVec3 } from '../utils/nan-guard.js';

export interface RetreatParams {
    distance?: number;
    /** Specific entity to flee from (position) */
    from?: { x: number; y: number; z: number };
}

export class RetreatSkill extends BaseSkill<RetreatParams> {
    readonly name = 'retreat';
    readonly description = 'Quickly move away from danger.';
    readonly defaultTimeoutMs = 8000;
    readonly maxRetries = 0;

    private bot: Bot;

    constructor(bot: Bot) {
        super();
        this.bot = bot;
    }

    protected async _execute(
        params: RetreatParams,
        ctx: SkillContext,
    ): Promise<SkillResult> {
        const { distance = 16, from } = params;
        const pos = this.bot.entity.position;

        // Cannot retreat if NaN
        if (Number.isNaN(pos.x) || Number.isNaN(pos.y) || Number.isNaN(pos.z)) {
            return this.result(false, 'Position is NaN', 'internal_error');
        }

        // Calculate flee direction
        let fleeX: number;
        let fleeZ: number;

        if (from && !Number.isNaN(from.x) && !Number.isNaN(from.z)) {
            const dx = pos.x - from.x;
            const dz = pos.z - from.z;
            const len = Math.sqrt(dx * dx + dz * dz) || 1;
            fleeX = pos.x + (dx / len) * distance;
            fleeZ = pos.z + (dz / len) * distance;
        } else {
            // No specific target — just run in a random direction
            const angle = Math.random() * Math.PI * 2;
            fleeX = pos.x + Math.cos(angle) * distance;
            fleeZ = pos.z + Math.sin(angle) * distance;
        }

        // First: stop current movement and sprint-jump away
        this.bot.pathfinder.stop();
        this.bot.clearControlStates();
        nanTracer.trace('retreat.start', { pos, from: from ?? 'none', distance });

        // Set sprint
        try { this.bot.setControlState('sprint', true); } catch {}
        try { this.bot.setControlState('jump', true); } catch {}

        // Face away from danger and start moving
        const lookX = pos.x - (fleeX - pos.x);
        const lookZ = pos.z - (fleeZ - pos.z);
        try {
            const { GoalNear } = require('mineflayer-pathfinder').goals;
            this.bot.pathfinder.setGoal(new GoalNear(
                Math.round(fleeX),
                Math.round(pos.y),
                Math.round(fleeZ),
                2,
            ));
        } catch {}

        // Brief burst then use pathfinder
        await this.sleep(300);
        try { this.bot.setControlState('sprint', false); } catch {}
        try { this.bot.setControlState('jump', false); } catch {}

        // Use pathfinder to reach flee destination
        return new Promise((resolve) => {
            const timeout = Math.min(ctx.deadline - Date.now(), 5000);

            const done = () => {
                clearTimeout(timer);
                resolve(this.result(true, `Retreated ~${distance.toFixed(0)} blocks`));
            };
            const fail = (err: Error) => {
                clearTimeout(timer);
                resolve(this.result(false, err.message, 'path_stuck'));
            };

            const timer = setTimeout(() => {
                this.bot.pathfinder.stop();
                resolve(this.result(true, `Partial retreat`));
            }, timeout);

            this.bot.once('goal_reached', done);
            setTimeout(() => this.bot.removeListener('goal_reached', done), timeout);

            // Simple pathfinder goto as fallback
            const { GoalNear } = require('mineflayer-pathfinder').goals;
            this.bot.pathfinder.goto(
                new GoalNear(Math.round(fleeX), Math.round(pos.y), Math.round(fleeZ), 2),
            ).catch(fail);
        });
    }
}

/** Inline attack function — not a full skill, used by core */
export function attackNearestHostile(bot: Bot): boolean {
    const pos = bot.entity?.position;
    if (!pos) return false;

    let nearest: any = null;
    let minDist = Infinity;

    const hostileNames = [
        'zombie', 'skeleton', 'spider', 'creeper', 'enderman',
        'witch', 'slime', 'phantom', 'drowned', 'pillager',
        'vindicator', 'evoker', 'ravager', 'hoglin', 'piglin',
        'blaze', 'ghast', 'silverfish', 'endermite', 'vex',
    ];

    for (const [, entity] of Object.entries(bot.entities)) {
        if (!entity || entity === bot.entity) continue;
        const ep = entity.position;
        if (Number.isNaN(ep.x) || Number.isNaN(ep.y) || Number.isNaN(ep.z)) continue;
        const name = ((entity as any).name ?? '').toLowerCase();
        if (!hostileNames.some((h) => name.includes(h))) continue;

        const dist = pos.distanceTo(ep);
        if (dist <= 4 && dist < minDist) {
            minDist = dist;
            nearest = entity;
        }
    }

    if (nearest) {
        const targetPos = nearest.position.offset(0, 1, 0);
        if (!isFiniteVec3(targetPos)) {
            nanTracer.trace('attack skipped — target pos not finite', { entity: nearest.name });
            return false;
        }
        try { bot.lookAt(targetPos); } catch {}
        nanTracer.trace('attack', { target: nearest.name, targetPos, pos: bot.entity.position });
        try { bot.attack(nearest as any); } catch {}
        return true;
    }
    return false;
}

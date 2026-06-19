import type { Bot } from 'mineflayer';
import { BaseSkill } from './base.js';
import type { SkillResult } from '../types/index.js';

export interface RetreatParams { distance: number }

export class RetreatSkill extends BaseSkill<RetreatParams> {
    readonly name = 'retreat';
    readonly defaultTimeoutMs = 8000;
    constructor(private bot: Bot) { super(); }

    protected async _execute(params: RetreatParams): Promise<SkillResult> {
        const hostile = this.findNearestHostile();
        if (!hostile) return this.result(true, 'No threat nearby');
        const dx = this.bot.entity.position.x - hostile.position.x;
        const dz = this.bot.entity.position.z - hostile.position.z;
        const angle = Math.atan2(dz, dx);
        const dist = params.distance ?? 16;
        const tx = this.bot.entity.position.x + Math.cos(angle) * dist;
        const tz = this.bot.entity.position.z + Math.sin(angle) * dist;
        try {
            await this.bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals.GoalNear)(tx, this.bot.entity.position.y, tz, 3));
            return this.result(true, `Retreated ${dist.toFixed(0)}m from ${hostile.name}`);
        } catch { return this.result(true, 'Retreat attempted'); }
    }

    private findNearestHostile(): any {
        let closest: any = null;
        let minDist = Infinity;
        const pos = this.bot.entity.position;
        for (const [, e] of Object.entries(this.bot.entities)) {
            if (!e) continue;
            const type = (e as any).type;
            if (type !== 'mob' && type !== 'hostile') continue;
            const name = ((e as any).name ?? '').toLowerCase();
            if (['zombie','skeleton','spider','creeper','enderman'].some(h => name.includes(h))) {
                const d = pos.distanceTo(e.position);
                if (d < minDist) { minDist = d; closest = e; }
            }
        }
        return closest;
    }
}

export function attackNearestHostile(bot: Bot): boolean {
    const pos = bot.entity?.position;
    if (!pos) return false;
    let nearest: any = null;
    let minDist = Infinity;
    for (const [, e] of Object.entries(bot.entities)) {
        if (!e) continue;
        const name = ((e as any).name ?? '').toLowerCase();
        if (['zombie','skeleton','spider','creeper','enderman'].some(h => name.includes(h))) {
            const d = pos.distanceTo(e.position);
            if (d < minDist && d <= 4) { minDist = d; nearest = e; }
        }
    }
    if (!nearest) return false;
    try { bot.lookAt(nearest.position.offset(0, 1, 0)); } catch {}
    try { bot.attack(nearest as any); } catch {}
    return true;
}

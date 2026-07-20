import type { Bot } from 'mineflayer';

export type TaskSnapshot = {
    pos: { x: number; y: number; z: number } | null;
    inventory: Record<string, number>;
    nearbyEntities: Record<string, number>;
};

export type VerificationResult = {
    ok: boolean;
    detail: string;
};

export function captureTaskSnapshot(bot: Bot): TaskSnapshot {
    const pos = bot.entity?.position;
    const inventory: Record<string, number> = {};
    for (const item of bot.inventory?.items?.() ?? []) {
        const name = ((item as any).name ?? '').toString();
        inventory[name] = (inventory[name] ?? 0) + item.count;
    }

    const nearbyEntities: Record<string, number> = {};
    for (const [, entity] of Object.entries(bot.entities)) {
        if (!entity || (entity as any) === bot.entity) continue;
        const name = (((entity as any).name ?? (entity as any).displayName ?? (entity as any).type ?? '') as string).toLowerCase();
        if (!name) continue;
        const d = pos ? pos.distanceTo((entity as any).position) : Infinity;
        if (d > 20) continue;
        nearbyEntities[name] = (nearbyEntities[name] ?? 0) + 1;
    }

    return {
        pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
        inventory,
        nearbyEntities,
    };
}

function countByAliases(values: Record<string, number>, aliases: string[]): number {
    let total = 0;
    for (const [name, count] of Object.entries(values)) {
        if (aliases.some((alias) => name.includes(alias))) total += count;
    }
    return total;
}

function aliasesForCollectTarget(target: string): string[] {
    const normalized = String(target || '').toLowerCase();
    if (normalized.includes('stone')) return ['cobblestone', 'stone'];
    if (normalized.includes('coal')) return ['coal', 'coal_ore'];
    if (normalized.includes('iron')) return ['raw_iron', 'iron_ore'];
    return [normalized];
}

function aliasesForAttackTarget(target: string): string[] {
    const normalized = String(target || '').toLowerCase();
    if (normalized.includes('sheep')) return ['wool', 'mutton'];
    if (normalized.includes('pig')) return ['porkchop'];
    if (normalized.includes('cow')) return ['beef', 'leather'];
    if (normalized.includes('zombie')) return ['rotten_flesh'];
    if (normalized.includes('spider')) return ['string', 'spider_eye'];
    return [normalized];
}

export function verifyTask(type: string, params: any, before: TaskSnapshot, after: TaskSnapshot): VerificationResult {
    if (type === 'collect') {
        const aliases = aliasesForCollectTarget(params?.target || '');
        const beforeCount = countByAliases(before.inventory, aliases);
        const afterCount = countByAliases(after.inventory, aliases);
        return afterCount > beforeCount
            ? { ok: true, detail: `verified inventory increased for ${aliases.join('/')}: ${beforeCount} -> ${afterCount}` }
            : { ok: false, detail: `inventory did not increase for ${aliases.join('/')}` };
    }

    if (type === 'craft' || type === 'craft_chain') {
        const item = String(params?.item || '').toLowerCase();
        const beforeCount = countByAliases(before.inventory, [item]);
        const afterCount = countByAliases(after.inventory, [item]);
        return afterCount > beforeCount
            ? { ok: true, detail: `verified crafted ${item}: ${beforeCount} -> ${afterCount}` }
            : { ok: false, detail: `crafted item ${item} not found or unchanged in inventory` };
    }

    if (type === 'attack_entity') {
        const target = String(params?.target || '').toLowerCase();
        const beforeDrops = countByAliases(before.inventory, aliasesForAttackTarget(target));
        const afterDrops = countByAliases(after.inventory, aliasesForAttackTarget(target));
        const beforeNearby = before.nearbyEntities[target] ?? 0;
        const afterNearby = after.nearbyEntities[target] ?? 0;
        if (afterDrops > beforeDrops || afterNearby < beforeNearby) {
            return { ok: true, detail: `verified attack on ${target}: drops ${beforeDrops} -> ${afterDrops}, nearby ${beforeNearby} -> ${afterNearby}` };
        }
        return { ok: false, detail: `attack on ${target} produced no verified drops or entity reduction` };
    }

    if (type === 'move_to') {
        if (!after.pos) return { ok: false, detail: 'missing bot position after move' };
        const dx = after.pos.x - Number(params?.x ?? 0);
        const dy = after.pos.y - Number(params?.y ?? 0);
        const dz = after.pos.z - Number(params?.z ?? 0);
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const reachDistance = Number(params?.reachDistance ?? 2);
        return dist <= Math.max(reachDistance + 1, 3)
            ? { ok: true, detail: `verified move_to distance=${dist.toFixed(1)}` }
            : { ok: false, detail: `move_to still too far from target distance=${dist.toFixed(1)}` };
    }

    return { ok: true, detail: 'no verifier for task type; execution accepted' };
}

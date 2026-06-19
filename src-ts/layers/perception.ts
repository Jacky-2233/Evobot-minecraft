/**
 * Perception Layer
 *
 * Scans the bot's surroundings every tick and produces a
 * WorldStateSummary. Used by safety, behavior, and planner.
 */
import type { Bot } from 'mineflayer';
import {
    WorldStateSummary,
    Vec3,
    EntitySummary,
    BlockSummary,
} from '../types/index.js';

export interface PerceptionConfig {
    scanRadius: number;
    hostileRadius: number;
    blockScanRadius: number;
    updateIntervalMs: number;
}

const DEFAULT_CONFIG: PerceptionConfig = {
    scanRadius: 50,
    hostileRadius: 30,
    blockScanRadius: 15,
    updateIntervalMs: 500,
};

export class Perception {
    private bot: Bot;
    private config: PerceptionConfig;
    private _summary: WorldStateSummary | null = null;
    private lastUpdate = 0;

    constructor(bot: Bot, config?: Partial<PerceptionConfig>) {
        this.bot = bot;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /** Get most recent summary (cached) */
    get summary(): WorldStateSummary | null {
        return this._summary;
    }

    /** Force refresh and return summary */
    scan(): WorldStateSummary {
        const now = Date.now();
        if (this._summary && now - this.lastUpdate < this.config.updateIntervalMs) {
            return this._summary;
        }

        const pos = this.bot.entity?.position;
        const vpos: Vec3 = pos
            ? { x: pos.x, y: pos.y, z: pos.z }
            : { x: NaN, y: NaN, z: NaN };

        const nearbyHostile = this.scanEntities('hostile');
        const nearbyPlayers = this.scanEntities('player');
        const nearbyBlocks = this.scanBlocks();

        this._summary = {
            position: vpos,
            health: this.bot.health ?? 0,
            food: this.bot.food ?? 0,
            onGround: this.bot.entity?.onGround ?? false,
            timeOfDay: this.getTimeOfDay(),
            nearbyHostile,
            nearbyPlayers,
            nearbyBlocks,
            inventorySlots: this.bot.inventory?.items().length ?? 0,
            activeTask: null, // filled by executor
        };

        this.lastUpdate = now;
        return this._summary;
    }

    private scanEntities(filter: 'hostile' | 'player'): EntitySummary[] {
        if (!this.bot.entities) return [];
        const pos = this.bot.entity?.position;
        if (!pos) return [];

        const results: EntitySummary[] = [];
        const radius = this.config.scanRadius;

        for (const [, entity] of Object.entries(this.bot.entities)) {
            if (!entity || entity === this.bot.entity) continue;
            const ep = entity.position;
            if (Number.isNaN(ep.x) || Number.isNaN(ep.y) || Number.isNaN(ep.z)) continue;

            const dist = pos.distanceTo(ep);
            if (dist > radius) continue;

            const type = this.classifyEntity(entity);

            if (filter === 'hostile' && type !== 'mob') continue;
            if (filter === 'player' && type !== 'player') continue;

            results.push({
                name: entity.name ?? entity.displayName ?? 'unknown',
                type,
                distance: dist,
                position: { x: ep.x, y: ep.y, z: ep.z },
            });
        }

        return results.sort((a, b) => a.distance - b.distance);
    }

    private classifyEntity(entity: any): EntitySummary['type'] {
        const name = (entity.name ?? '').toLowerCase();
        if (entity.type === 'player') return 'player';

        const hostile: string[] = [
            'zombie', 'skeleton', 'spider', 'creeper', 'enderman',
            'witch', 'slime', 'phantom', 'drowned', 'pillager',
            'vindicator', 'evoker', 'ravager', 'hoglin', 'piglin',
            'blaze', 'ghast', 'wither_skeleton', 'magma_cube',
            'guardian', 'elder_guardian', 'shulker', 'silverfish',
            'endermite', 'vex', 'warden',
        ];
        const animal: string[] = [
            'cow', 'pig', 'sheep', 'chicken', 'horse', 'donkey',
            'cat', 'dog', 'wolf', 'rabbit', 'fox', 'bee', 'goat',
            'llama', 'turtle', 'panda', 'polar_bear', 'dolphin',
            'squid', 'glow_squid',
        ];

        if (hostile.some((h) => name.includes(h))) return 'mob';
        if (animal.some((a) => name.includes(a))) return 'animal';
        if (entity.type === 'object' || name === 'item') return 'item';
        return 'other';
    }

    private scanBlocks(): BlockSummary[] {
        if (!this.bot.entity) return [];
        const pos = this.bot.entity.position.floored();
        const r = this.config.blockScanRadius;
        const blockMap = new Map<string, Vec3[]>();

        for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dz = -r; dz <= r; dz++) {
                    const bp = pos.offset(dx, dy, dz);
                    const block = this.bot.blockAt(bp);
                    if (!block || block.name === 'air') continue;
                    const v: Vec3 = { x: bp.x, y: bp.y, z: bp.z };
                    const existing = blockMap.get(block.name);
                    if (existing) {
                        existing.push(v);
                    } else {
                        blockMap.set(block.name, [v]);
                    }
                }
            }
        }

        const results: BlockSummary[] = [];
        for (const [name, positions] of blockMap) {
            results.push({ name, count: positions.length, positions });
        }
        return results.sort((a, b) => b.count - a.count);
    }

    private getTimeOfDay(): WorldStateSummary['timeOfDay'] {
        const time = (this.bot.time?.timeOfDay ?? 0) % 24000;
        if (time < 13000) return 'day';
        if (time < 13800) return 'sunset';
        return 'night';
    }

    /** Quick check: are hostiles within danger range */
    hasNearbyHostile(within = this.config.hostileRadius): boolean {
        const summary = this.scan();
        return summary.nearbyHostile.some((e) => e.distance <= within);
    }

    /** Get hostile closest to bot */
    getClosestHostile(): EntitySummary | null {
        const summary = this.scan();
        return summary.nearbyHostile[0] ?? null;
    }
}

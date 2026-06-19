/**
 * Behavior Engine
 *
 * Priority-based behavior selection. Each tick, evaluates all
 * behaviors by priority (highest first). The first whose condition
 * is true gets activated. Runs until its tick() returns false or
 * a higher-priority behavior interrupts.
 */
import {
    BehaviorNode,
    BehaviorPriority,
    Priority,
} from '../types/index.js';

export class BehaviorEngine {
    private nodes: BehaviorNode[] = [];
    private active: BehaviorNode | null = null;
    private cooldowns = new Map<string, number>();
    private _running = false;
    private _paused = false;

    /** Register a behavior node */
    register(node: BehaviorNode): void {
        this.nodes.push(node);
        this.nodes.sort((a, b) => b.priority - a.priority);
    }

    /** Unregister */
    unregister(name: string): void {
        this.nodes = this.nodes.filter((n) => n.name !== name);
    }

    /** Pause behavior engine (e.g. during safety override) */
    pause(): void {
        this._paused = true;
    }

    resume(): void {
        this._paused = false;
    }

    /** Get currently active behavior name */
    get activeName(): string | null {
        return this.active?.name ?? null;
    }

    /** Main tick — call from bot update loop */
    async tick(): Promise<void> {
        if (this._paused || !this._running) return;

        const now = Date.now();

        // Check if current behavior should be interrupted
        if (this.active) {
            // Check cooldown
            const cd = this.cooldowns.get(this.active.name) ?? 0;
            if (now < cd) return;

            // See if a higher-priority behavior needs to take over
            for (const node of this.nodes) {
                if (node.priority <= this.active.priority) break;

                const nodeCd = this.cooldowns.get(node.name) ?? 0;
                if (now < nodeCd) continue;

                if (node.condition()) {
                    this.active = node;
                    break;
                }
            }

            // Run current behavior (guard against null after await)
            const current = this.active;
            if (current) {
                try {
                    const keepRunning = await current.tick();
                    if (!keepRunning) {
                        this.cooldowns.set(current.name, now + current.cooldownMs);
                        this.active = null;
                    }
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(`[Behavior] ${current.name} error: ${msg}`);
                    this.cooldowns.set(current.name, now + current.cooldownMs);
                    this.active = null;
                }
            }
        } else {
            // Find next behavior to activate
            for (const node of this.nodes) {
                const cd = this.cooldowns.get(node.name) ?? 0;
                if (now < cd) continue;

                if (node.condition()) {
                    this.active = node;
                    break;
                }
            }
        }
    }

    /** Prevent a behavior from activating for `ms` milliseconds */
    cooldown(name: string, ms: number): void {
        this.cooldowns.set(name, Date.now() + ms);
    }

    /** Start the engine */
    start(): void {
        this._running = true;
    }

    /** Stop the engine */
    stop(): void {
        this._running = false;
        this.active = null;
    }
}

// ─── Built-in Behaviors ──────────────────────────────────────────

import type { Bot } from 'mineflayer';
import type { Perception } from '../layers/perception.js';
import type { Memory } from '../layers/memory.js';
import type { Executor } from '../executor/executor.js';

export interface BehaviorDeps {
    bot: Bot;
    perception: Perception;
    memory: Memory;
    executor: Executor;
}

/** Wander randomly when idle */
export function createWanderBehavior(deps: BehaviorDeps): BehaviorNode {
    return {
        name: 'wander',
        priority: Priority.IDLE,
        condition: () => {
            return deps.executor.isIdle();
        },
        tick: async () => {
            const pos = deps.bot.entity.position;
            const rx = pos.x + (Math.random() * 20 - 10);
            const rz = pos.z + (Math.random() * 20 - 10);
            const ground = deps.bot.blockAt(
                deps.bot.entity.position.floored().offset(0, -1, 0),
            );
            const y = ground ? ground.position.y + 1 : pos.y;

            deps.executor.enqueue({
                id: `wander-${Date.now().toString(36)}`,
                type: 'move_to',
                params: {
                    x: Math.round(rx),
                    y: Math.round(y),
                    z: Math.round(rz),
                    reachDistance: 3,
                },
                priority: Priority.IDLE,
                source: 'behavior',
                createdAt: Date.now(),
            });
            return false; // one-shot, will re-evaluate next tick
        },
        cooldownMs: 45000,
    };
}

/** Collect nearby useful resources when idle */
export function createGatherBehavior(deps: BehaviorDeps): BehaviorNode {
    const priorityBlocks = ['log', 'ore', 'coal', 'iron', 'stone', 'dirt', 'cobblestone'];

    return {
        name: 'gather',
        priority: Priority.IDLE_TASK,
        condition: () => {
            if (!deps.executor.isIdle()) return false;
            const s = deps.perception.scan();
            return s.nearbyBlocks.some((b) =>
                priorityBlocks.some((pb) => b.name.includes(pb)),
            );
        },
        tick: async () => {
            const s = deps.perception.scan();
            for (const pb of priorityBlocks) {
                const match = s.nearbyBlocks.find((b) => b.name.includes(pb) && b.count >= 1);
                if (match) {
                    deps.executor.enqueue({
                        id: `gather-${Date.now().toString(36)}`,
                        type: 'collect',
                        params: { target: match.name, count: 2, maxDistance: 10 },
                        priority: Priority.IDLE_TASK,
                        source: 'behavior',
                        createdAt: Date.now(),
                    });
                    return false;
                }
            }
            return false;
        },
        cooldownMs: 60000,
    };
}

/** Eat when hungry */
export function createAutoEatBehavior(deps: BehaviorDeps): BehaviorNode {
    return {
        name: 'auto_eat',
        priority: Priority.SAFETY,
        condition: () => {
            const food = deps.bot.food ?? 20;
            return food <= (deps as any).hungerThreshold ?? 16;
        },
        tick: async () => {
            const foodItem = deps.bot.inventory
                .items()
                .find((i) =>
                    i.name.includes('cooked') ||
                    i.name.includes('steak') ||
                    i.name.includes('porkchop') ||
                    i.name.includes('mutton') ||
                    i.name.includes('chicken') ||
                    i.name.includes('beef') ||
                    i.name.includes('rabbit') ||
                    i.name.includes('salmon') ||
                    i.name.includes('cod') ||
                    i.name.includes('bread') ||
                    i.name.includes('potato') ||
                    i.name.includes('carrot') ||
                    i.name.includes('apple'),
                );
            if (foodItem) {
                await deps.bot.equip(foodItem, 'hand').catch(() => {});
                await deps.bot.consume().catch(() => {});
            }
            return false; // done eating, will check condition again next tick
        },
        cooldownMs: 5000,
    };
}

/** Periodic idle chat */
export function createSocialBehavior(deps: BehaviorDeps): BehaviorNode {
    const chats = [
        'Just vibing here',
        'Hello world',
        'Beep boop',
        'What a nice day in Minecraft',
        'Anyone need help?',
    ];

    return {
        name: 'social',
        priority: Priority.IDLE - 1,
        condition: () => {
            return deps.executor.isIdle() && deps.perception.scan().nearbyPlayers.length > 0;
        },
        tick: async () => {
            const msg = chats[Math.floor(Math.random() * chats.length)];
            deps.bot.chat(msg);
            return false;
        },
        cooldownMs: 60000,
    };
}

/** Pick up nearby dropped items when idle */
export function createPickupBehavior(deps: BehaviorDeps): BehaviorNode {
    return {
        name: 'pickup',
        priority: Priority.EXPLORE,
        condition: () => {
            if (!deps.executor.isIdle()) return false;
            if (deps.bot.inventory.emptySlotCount() <= 1) return false;
            return hasNearbyItemEntity(deps.bot, 8);
        },
        tick: async () => {
            deps.executor.enqueue({
                id: `pickup-${Date.now().toString(36)}`,
                type: 'pickup',
                params: { scanRadius: 8, maxItems: 3 },
                priority: Priority.EXPLORE,
                source: 'behavior',
                createdAt: Date.now(),
            });
            return false;
        },
        cooldownMs: 20000,
    };
}

function hasNearbyItemEntity(bot: Bot, radius: number): boolean {
    if (!bot.entities) return false;
    const pos = bot.entity?.position;
    if (!pos) return false;

    for (const [, entity] of Object.entries(bot.entities)) {
        if (!entity) continue;
        const name = (entity as any).name?.toLowerCase() ?? '';
        const type = (entity as any).type;
        if (name !== 'item' && type !== 'object') continue;

        const ep = entity.position;
        if (Number.isNaN(ep.x) || Number.isNaN(ep.y) || Number.isNaN(ep.z)) continue;
        if (pos.distanceTo(ep) <= radius) return true;
    }
    return false;
}

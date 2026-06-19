/**
 * Safety Layer
 *
 * Monitors danger conditions every tick. Pauses executor and
 * injects survival tasks when necessary.
 */
import type { Bot } from 'mineflayer';
import { Perception } from './perception.js';
import { Executor } from '../executor/executor.js';
import { Priority } from '../types/index.js';

export interface SafetyConfig {
    hungerThreshold: number;
    lowHealthThreshold: number;
    criticalHealthThreshold: number;
    stuckTimeoutMs: number;
    hostileEvadeDistance: number;
    /** Minimum movement in blocks to not be considered stuck */
    stuckMinDistance: number;
}

const DEFAULT_CONFIG: SafetyConfig = {
    hungerThreshold: 16,
    lowHealthThreshold: 8,
    criticalHealthThreshold: 4,
    stuckTimeoutMs: 20000,
    hostileEvadeDistance: 8,
    stuckMinDistance: 1.5,
};

export class Safety {
    private bot: Bot;
    private perception: Perception;
    private config: SafetyConfig;

    private _pausedUntil = 0;
    private _lastMoveMs = 0;
    private _lastPos: { x: number; y: number; z: number } | null = null;
    private _stuckWarned = false;
    private _recoveryPhase: 'none' | 'eat' | 'evade' | 'unstuck' = 'none';
    private _spawnGraceUntil = 0;
    private _safetyTaskActive = false;

    constructor(
        bot: Bot,
        perception: Perception,
        config?: Partial<SafetyConfig>,
    ) {
        this.bot = bot;
        this.perception = perception;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /** Called after spawn to set a grace period */
    markSpawned(): void {
        this._spawnGraceUntil = Date.now() + 10000;
        this._lastMoveMs = Date.now();
        this._lastPos = null;
        this._stuckWarned = false;
        this._recoveryPhase = 'none';
        this._safetyTaskActive = false;
    }

    /** Called by core when damage is taken — immediate response */
    onDamaged(executor: Executor): void {
        const now = Date.now();
        this._safetyTaskActive = true;
        this._recoveryPhase = 'evade';
        this._pausedUntil = now + 8000;

        const hostile = this.perception.getClosestHostile();
        if (hostile) {
            console.warn(`[Safety] Damaged by ${hostile.name} — retreating!`);
            executor.enqueue({
                id: `safety-damage-${now.toString(36)}`,
                type: 'retreat',
                params: {
                    distance: 16,
                    from: hostile.position,
                },
                priority: Priority.SURVIVAL,
                source: 'behavior',
                createdAt: now,
            });
        } else {
            this.evadeHostiles(executor);
        }
    }

    get recoveryPhase(): string {
        return this._recoveryPhase;
    }

    /** Call every tick — monitors conditions and injects safety tasks */
    tick(executor: Executor): void {
        const summary = this.perception.scan();
        const now = Date.now();

        // Grace period after spawn — skip all checks
        if (now < this._spawnGraceUntil) return;

        // If a safety task is still active, don't pile on
        if (this._safetyTaskActive && now < this._pausedUntil) return;

        // Update movement tracking
        const pos = this.bot.entity?.position;
        if (pos && this._lastPos) {
            const dx = pos.x - this._lastPos.x;
            const dy = pos.y - this._lastPos.y;
            const dz = pos.z - this._lastPos.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            if (dist > 0.15) {
                this._lastMoveMs = now;
                this._lastPos = { x: pos.x, y: pos.y, z: pos.z };
                this._stuckWarned = false;
            }
        } else if (pos) {
            this._lastPos = { x: pos.x, y: pos.y, z: pos.z };
            this._lastMoveMs = now;
        }

        // 1. Critical health: log out / idle
        if (summary.health <= this.config.criticalHealthThreshold) {
            if (this._recoveryPhase !== 'evade') {
                console.warn('[Safety] CRITICAL health — evading');
            }
            this._recoveryPhase = 'evade';
            this._safetyTaskActive = true;
            this.evadeHostiles(executor);
            this._pausedUntil = now + 12000;
            return;
        }

        // 2. Hostile nearby
        const closestHostile = this.perception.getClosestHostile();
        if (closestHostile && closestHostile.distance <= this.config.hostileEvadeDistance) {
            if (this._recoveryPhase !== 'evade') {
                console.warn(`[Safety] ${closestHostile.name} ${closestHostile.distance.toFixed(1)}m — evading`);
            }
            this._recoveryPhase = 'evade';
            this._safetyTaskActive = true;
            this.evadeHostiles(executor);
            this._pausedUntil = now + 10000;
            return;
        }

        // 3. Low hunger
        if (summary.food <= this.config.hungerThreshold && summary.food > 0) {
            if (this._recoveryPhase !== 'eat') {
                console.warn(`[Safety] Hunger ${summary.food} — eating`);
            }
            this._recoveryPhase = 'eat';
            this._safetyTaskActive = true;
            this.eatFood(executor);
            this._pausedUntil = now + 6000;
            return;
        }

        // 4. Stuck detection
        if (now - this._lastMoveMs > this.config.stuckTimeoutMs) {
            if (!this._stuckWarned) {
                console.warn(`[Safety] Stuck for ${((now - this._lastMoveMs) / 1000).toFixed(0)}s — recovering`);
                this._stuckWarned = true;
            }
            this._recoveryPhase = 'unstuck';
            this._safetyTaskActive = true;
            this.unstuck(executor);
            this._pausedUntil = now + 6000;
            return;
        }

        // All clear
        if (this._recoveryPhase !== 'none') {
            console.log('[Safety] Recovery complete, resuming normal operation');
        }
        this._recoveryPhase = 'none';
        this._pausedUntil = 0;
        this._safetyTaskActive = false;
    }

    private evadeHostiles(executor: Executor): void {
        this.bot.pathfinder?.stop();
        this.bot.clearControlStates();

        const hostile = this.perception.getClosestHostile();
        if (!hostile) return;

        executor.enqueue({
            id: `safety-evade-${Date.now().toString(36)}`,
            type: 'retreat',
            params: {
                distance: 16,
                from: hostile.position,
            },
            priority: Priority.SAFETY,
            source: 'behavior',
            createdAt: Date.now(),
        });
    }

    private eatFood(executor: Executor): void {
        executor.enqueue({
            id: `safety-eat-${Date.now().toString(36)}`,
            type: 'eat',
            params: {},
            priority: Priority.SURVIVAL,
            source: 'behavior',
            createdAt: Date.now(),
        });
    }

    private unstuck(executor: Executor): void {
        this.bot.pathfinder?.stop();
        const randomOffset = () => 2 + Math.random() * 4;
        const pos = this.bot.entity.position;

        executor.enqueue({
            id: `safety-unstuck-${Date.now().toString(36)}`,
            type: 'move_to',
            params: {
                x: pos.x + randomOffset(),
                y: pos.y,
                z: pos.z + randomOffset(),
                reachDistance: 2,
                timeoutMs: 8000,
            },
            priority: Priority.STUCK_RECOVERY,
            source: 'behavior',
            createdAt: Date.now(),
        });
    }
}

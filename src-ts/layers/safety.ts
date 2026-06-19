/**
 * Safety Layer
 *
 * Monitors danger conditions every tick. Can force-cancel (pathfinder.stop,
 * clearControlStates) for immediate safety. Task enqueuing goes through
 * raiseEmergency callback to Orchestrator.
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
    /** Callback to Orchestrator for emergency tasks */
    private _raiseEmergency: ((text: string, taskType: string, params: Record<string, unknown>) => void) | null = null;

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

    /** Set callback for emergency task submission (called by Orchestrator) */
    set onEmergency(cb: ((text: string, taskType: string, params: Record<string, unknown>) => void) | null) {
        this._raiseEmergency = cb;
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
            this._raiseEmergency?.('Damaged by hostile', 'retreat', {
                distance: 16,
                from: hostile.position,
            });
        } else {
            this.evadeHostiles();
        }
    }

    get recoveryPhase(): string {
        return this._recoveryPhase;
    }

    /** Call every tick — monitors conditions and injects safety tasks */
    tick(executor: Executor): void {
        const summary = this.perception.scan();
        const now = Date.now();

        if (now < this._spawnGraceUntil) return;
        if (this._safetyTaskActive && now < this._pausedUntil) return;

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

        if (summary.health <= this.config.criticalHealthThreshold) {
            if (this._recoveryPhase !== 'evade') console.warn('[Safety] CRITICAL health — evading');
            this._recoveryPhase = 'evade';
            this._safetyTaskActive = true;
            this.evadeHostiles();
            this._pausedUntil = now + 12000;
            return;
        }

        const closestHostile = this.perception.getClosestHostile();
        if (closestHostile && closestHostile.distance <= this.config.hostileEvadeDistance) {
            if (this._recoveryPhase !== 'evade') console.warn(`[Safety] ${closestHostile.name} ${closestHostile.distance.toFixed(1)}m — evading`);
            this._recoveryPhase = 'evade';
            this._safetyTaskActive = true;
            this.evadeHostiles();
            this._pausedUntil = now + 10000;
            return;
        }

        if (summary.food <= this.config.hungerThreshold && summary.food > 0) {
            if (this._recoveryPhase !== 'eat') console.warn(`[Safety] Hunger ${summary.food} — eating`);
            this._recoveryPhase = 'eat';
            this._safetyTaskActive = true;
            this.eatFood();
            this._pausedUntil = now + 6000;
            return;
        }

        if (now - this._lastMoveMs > this.config.stuckTimeoutMs) {
            if (!this._stuckWarned) {
                console.warn(`[Safety] Stuck for ${((now - this._lastMoveMs) / 1000).toFixed(0)}s — recovering`);
                this._stuckWarned = true;
            }
            this._recoveryPhase = 'unstuck';
            this._safetyTaskActive = true;
            this.unstuck();
            this._pausedUntil = now + 6000;
            return;
        }

        if (this._recoveryPhase !== 'none') {
            console.log('[Safety] Recovery complete, resuming normal operation');
        }
        this._recoveryPhase = 'none';
        this._pausedUntil = 0;
        this._safetyTaskActive = false;
    }

    private evadeHostiles(): void {
        // Safety can force-cancel body control immediately
        this.bot.pathfinder?.stop();
        this.bot.clearControlStates();

        const hostile = this.perception.getClosestHostile();
        if (!hostile) return;

        this._raiseEmergency?.('Evading hostile', 'retreat', {
            distance: 16,
            from: hostile.position,
        });
    }

    private eatFood(): void {
        this._raiseEmergency?.('Hunger low', 'eat', {});
    }

    private unstuck(): void {
        this.bot.pathfinder?.stop();
        const randomOffset = () => 2 + Math.random() * 4;
        const pos = this.bot.entity.position;

        this._raiseEmergency?.('Stuck recovery', 'move_to', {
            x: pos.x + randomOffset(),
            y: pos.y,
            z: pos.z + randomOffset(),
            reachDistance: 2,
            timeoutMs: 8000,
        });
    }
}

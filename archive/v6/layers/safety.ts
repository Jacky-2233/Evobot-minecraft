/**
 * Safety Layer
 *
 * Monitors danger conditions every tick.
 * ONLY judges and notifies — does NOT touch bot body directly.
 * Emergency stop/attack is handled by core via onEmergency callback.
 */
import type { Bot } from 'mineflayer';
import { Perception } from './perception.js';
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

export type SafetyPhase = 'none' | 'eat' | 'evade' | 'unstuck';

export interface SafetySignal {
    phase: SafetyPhase;
    text: string;
    taskType: string;
    taskParams: Record<string, unknown>;
}

export class Safety {
    private bot: Bot;
    private perception: Perception;
    private config: SafetyConfig;
    private _raiseEmergency: ((text: string, taskType: string, taskParams: Record<string, unknown>) => void) | null = null;

    private _pausedUntil = 0;
    private _lastMoveMs = 0;
    private _lastPos: { x: number; y: number; z: number } | null = null;
    private _stuckWarned = false;
    private _phase: SafetyPhase = 'none';
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

    set onEmergency(cb: ((text: string, taskType: string, taskParams: Record<string, unknown>) => void) | null) {
        this._raiseEmergency = cb;
    }

    get phase(): SafetyPhase { return this._phase; }
    get isActive(): boolean { return this._safetyTaskActive; }

    markSpawned(): void {
        this._spawnGraceUntil = Date.now() + 10000;
        this._lastMoveMs = Date.now();
        this._lastPos = null;
        this._stuckWarned = false;
        this._phase = 'none';
        this._safetyTaskActive = false;
    }

    /** Called by core when damage is taken — returns signal for core to act */
    onDamaged(): SafetySignal | null {
        const now = Date.now();
        this._safetyTaskActive = true;
        this._phase = 'evade';
        this._pausedUntil = now + 8000;

        const hostile = this.perception.getClosestHostile();
        if (hostile) {
            console.warn(`[Safety] Damaged by ${hostile.name} — retreating!`);
            const signal: SafetySignal = {
                phase: 'evade',
                text: 'Damaged by hostile',
                taskType: 'retreat',
                taskParams: { distance: 16, from: hostile.position },
            };
            this._raiseEmergency?.(signal.text, signal.taskType, signal.taskParams);
            return signal;
        }
        return null;
    }

    /** Call every tick — returns signal if action needed, null if safe */
    tick(): SafetySignal | null {
        const summary = this.perception.scan();
        const now = Date.now();

        if (now < this._spawnGraceUntil) return null;
        if (this._safetyTaskActive && now < this._pausedUntil) return null;

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

        // 1. Critical health
        if (summary.health <= this.config.criticalHealthThreshold) {
            if (this._phase !== 'evade') console.warn('[Safety] CRITICAL health — evading');
            this._phase = 'evade';
            this._safetyTaskActive = true;
            this._pausedUntil = now + 12000;
            const hostile = this.perception.getClosestHostile();
            const signal: SafetySignal = {
                phase: 'evade',
                text: 'Critical health',
                taskType: 'retreat',
                taskParams: { distance: 16, from: hostile?.position ?? { x: 0, y: 0, z: 0 } },
            };
            this._raiseEmergency?.(signal.text, signal.taskType, signal.taskParams);
            return signal;
        }

        // 2. Hostile nearby
        const closestHostile = this.perception.getClosestHostile();
        if (closestHostile && closestHostile.distance <= this.config.hostileEvadeDistance) {
            if (this._phase !== 'evade') console.warn(`[Safety] ${closestHostile.name} ${closestHostile.distance.toFixed(1)}m — evading`);
            this._phase = 'evade';
            this._safetyTaskActive = true;
            this._pausedUntil = now + 10000;
            const signal: SafetySignal = {
                phase: 'evade',
                text: `Hostile ${closestHostile.name}`,
                taskType: 'retreat',
                taskParams: { distance: 16, from: closestHostile.position },
            };
            this._raiseEmergency?.(signal.text, signal.taskType, signal.taskParams);
            return signal;
        }

        // 3. Hunger
        if (summary.food <= this.config.hungerThreshold && summary.food > 0) {
            if (this._phase !== 'eat') console.warn(`[Safety] Hunger ${summary.food} — eating`);
            this._phase = 'eat';
            this._safetyTaskActive = true;
            this._pausedUntil = now + 6000;
            const signal: SafetySignal = {
                phase: 'eat',
                text: 'Hunger low',
                taskType: 'eat',
                taskParams: {},
            };
            this._raiseEmergency?.(signal.text, signal.taskType, signal.taskParams);
            return signal;
        }

        // 4. Stuck
        if (now - this._lastMoveMs > this.config.stuckTimeoutMs) {
            if (!this._stuckWarned) {
                console.warn(`[Safety] Stuck for ${((now - this._lastMoveMs) / 1000).toFixed(0)}s — recovering`);
                this._stuckWarned = true;
            }
            this._phase = 'unstuck';
            this._safetyTaskActive = true;
            this._pausedUntil = now + 6000;
            const randomOffset = () => 2 + Math.random() * 4;
            const p = this.bot.entity.position;
            const signal: SafetySignal = {
                phase: 'unstuck',
                text: 'Stuck recovery',
                taskType: 'move_to',
                taskParams: {
                    x: p.x + randomOffset(),
                    y: p.y,
                    z: p.z + randomOffset(),
                    reachDistance: 2,
                    timeoutMs: 8000,
                },
            };
            this._raiseEmergency?.(signal.text, signal.taskType, signal.taskParams);
            return signal;
        }

        // 5. All clear
        if (this._phase !== 'none') {
            console.log('[Safety] Recovery complete, resuming normal operation');
        }
        this._phase = 'none';
        this._pausedUntil = 0;
        this._safetyTaskActive = false;
        return null;
    }
}

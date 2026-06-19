/**
 * Position Health State Machine
 *
 * Tracks bot position quality across 3 states:
 *   trusted  — position is valid, all actions allowed
 *   degraded — recently NaN'd or reconnected, conservative moves only
 *   invalid  — position is NaN, block everything dangerous
 *
 * Auto-recovers from degraded→trusted after stabilization period.
 */
import type { Bot } from 'mineflayer';
import { isFiniteVec3 } from '../utils/nan-guard.js';

export type PositionState = 'trusted' | 'degraded' | 'invalid';

export interface PositionHealthConfig {
    /** How long after NaN recovery to stay in degraded state (ms) */
    degradedDurationMs: number;
    /** How long after spawn to stay in degraded state (ms) */
    spawnDegradedMs: number;
    /** Min distance moved before considering position trusted again (blocks) */
    minStabilizeDistance: number;
}

const DEFAULT_CONFIG: PositionHealthConfig = {
    degradedDurationMs: 3000,
    spawnDegradedMs: 5000,
    minStabilizeDistance: 0.5,
};

export class PositionHealth {
    private bot: Bot;
    private config: PositionHealthConfig;
    private _state: PositionState = 'degraded';
    private _degradedUntil = 0;
    private _lastValidPos: { x: number; y: number; z: number } | null = null;
    private _nanCount = 0;
    /** Callback when position becomes invalid — notifies Orchestrator */
    onInvalid: (() => void) | null = null;

    constructor(bot: Bot, config?: Partial<PositionHealthConfig>) {
        this.bot = bot;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    get state(): PositionState {
        return this._state;
    }

    get canMove(): boolean {
        return this._state !== 'invalid';
    }

    get canAttack(): boolean {
        return this._state === 'trusted';
    }

    get canSetGoal(): boolean {
        return this._state !== 'invalid';
    }

    get nanCount(): number {
        return this._nanCount;
    }

    get lastValidPosition(): { x: number; y: number; z: number } | null {
        return this._lastValidPos;
    }

    /** Call this on spawn — starts in degraded until world syncs */
    markSpawned(): void {
        this._state = 'degraded';
        this._degradedUntil = Date.now() + this.config.spawnDegradedMs;
        this._nanCount = 0;
    }

    /** Call this every physics tick to evaluate position health */
    evaluate(): void {
        const pos = this.bot.entity?.position;
        const now = Date.now();

        // Check for NaN
        if (!isFiniteVec3(pos)) {
            if (this._state !== 'invalid') {
                console.warn(`[PosHealth] NaN detected (count: ${++this._nanCount})`);
                this._state = 'invalid';
                this.stabilize();
                this.onInvalid?.();
            }
            return;
        }

        // Valid position — update last valid
        if (pos) {
            this._lastValidPos = { x: pos.x, y: pos.y, z: pos.z };
        }

        // State transitions
        if (this._state === 'invalid') {
            // NaN cleared — transition to degraded
            console.log('[PosHealth] NaN cleared → degraded');
            this._state = 'degraded';
            this._degradedUntil = now + this.config.degradedDurationMs;
            return;
        }

        if (this._state === 'degraded') {
            if (now > this._degradedUntil) {
                // Check if position has stabilized (moved at least a bit)
                if (this._lastValidPos) {
                    // We need at least one position update cycle after degraded expires
                    this._state = 'trusted';
                }
            }
        }
    }

    /** Call when bot takes damage — may degrade position briefly */
    markDamaged(): void {
        // Briefly degrade after damage (knockback can cause momentary invalid state)
        if (this._state === 'trusted') {
            this._state = 'degraded';
            this._degradedUntil = Date.now() + 1000;
        }
    }

    /** Call when pathfinder is stuck — position may need basic movement to stabilize */
    markStuck(): void {
        if (this._state === 'trusted') {
            this._state = 'degraded';
            this._degradedUntil = Date.now() + 2000;
        }
    }

    /** Block dangerous operations */
    guardSetGoal(): boolean {
        if (!this.canSetGoal) {
            console.warn('[PosHealth] Blocked setGoal — position is invalid');
            return false;
        }
        return true;
    }

    guardAttack(): boolean {
        if (!this.canAttack) {
            return false;
        }
        return true;
    }

    guardLookAt(): boolean {
        if (!this.canMove) {
            return false;
        }
        return true;
    }

    /** Try to stabilize: clear controls, stop pathfinder, zero velocity */
    private stabilize(): void {
        try {
            this.bot.pathfinder?.stop();
            this.bot.clearControlStates();
            // Zero out velocity to prevent compounding NaN
            if (this.bot.entity?.velocity) {
                this.bot.entity.velocity.x = 0;
                this.bot.entity.velocity.y = 0;
                this.bot.entity.velocity.z = 0;
            }
        } catch {}
    }
}

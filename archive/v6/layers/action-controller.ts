/**
 * ActionController — 身体控制权锁
 *
 * 核心原则：同一时刻只有一个人能控制 bot 的身体。
 *
 * - Executor 执行前必须 acquire lock
 * - Safety 可以 forceRelease（紧急抢锁）
 * - Behavior / Planner / Chat 不能直接拿锁
 * - 没拿到锁的模块只能排队或放弃
 */
import type { Executor } from '../executor/executor.js';

export type ControlOwner =
    | 'none'
    | 'executor'
    | 'safety'
    | 'recovery'
    | 'commander';

export interface LockState {
    owner: ControlOwner;
    taskType?: string;
    acquiredAt: number;
    expiresAt?: number;
    lastForceAcquireReason?: string;
}

export class ActionController {
    private _owner: ControlOwner = 'none';
    private _taskType = '';
    private _acquiredAt = 0;
    private _expiresAt = 0;
    private _lastForceAcquireReason = '';
    private executor: Executor;

    constructor(executor: Executor) {
        this.executor = executor;
    }

    get owner(): ControlOwner { return this._owner; }
    get isLocked(): boolean { return this._owner !== 'none'; }
    get acquiredAt(): number { return this._acquiredAt; }
    get lastForceAcquireReason(): string { return this._lastForceAcquireReason; }

    get lockState(): LockState {
        return {
            owner: this._owner,
            taskType: this._taskType || undefined,
            acquiredAt: this._acquiredAt,
            expiresAt: this._expiresAt > 0 ? this._expiresAt : undefined,
            lastForceAcquireReason: this._lastForceAcquireReason || undefined,
        };
    }

    /** 尝试获取控制权 */
    acquire(owner: ControlOwner, taskType?: string, timeoutMs = 0): boolean {
        if (this._owner !== 'none' && this._owner !== owner) {
            return false; // 被别人持有
        }
        this._owner = owner;
        this._taskType = taskType ?? '';
        this._acquiredAt = Date.now();
        this._expiresAt = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
        return true;
    }

    /** 释放控制权 */
    release(owner: ControlOwner): void {
        if (this._owner !== owner) return;
        this._owner = 'none';
        this._taskType = '';
        this._acquiredAt = 0;
        this._expiresAt = 0;
    }

    /** Safety 强制抢锁 — 取消当前所有任务 */
    forceAcquire(owner: ControlOwner, reason: string): void {
        const prevOwner = this._owner;
        this._lastForceAcquireReason = reason;
        this._owner = owner;
        this._taskType = `emergency:${reason}`;
        this._acquiredAt = Date.now();
        this._expiresAt = 0;

        // 清理 executor
        this.executor.clear();
        console.log(`[ActionController] ${owner} force-acquired lock (was: ${prevOwner}) — ${reason}`);
    }

    /** 检查锁是否超时（自动释放） */
    tick(): void {
        if (this._owner === 'none') return;
        if (this._expiresAt > 0 && Date.now() > this._expiresAt) {
            console.log(`[ActionController] ${this._owner} lock expired`);
            this._owner = 'none';
            this._taskType = '';
            this._acquiredAt = 0;
            this._expiresAt = 0;
        }
    }
}

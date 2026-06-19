/**
 * Checkpoint Manager
 *
 * Saves/loads task progress to survive server disconnects.
 * Supports both task-level and step-level checkpoints.
 * Single file at logs/checkpoint.json, overwritten each save.
 */
import fs from 'fs';
import path from 'path';
import type { Bot } from 'mineflayer';
import type {
    Checkpoint,
    TaskCheckpoint,
    Vec3,
    StepCheckpoint,
    EnhancedCheckpoint,
} from '../types/index.js';

const DEFAULT_PATH = 'logs/checkpoint.json';
const STEP_CHECKPOINT_PATH = 'logs/step-checkpoint.json';

export class CheckpointManager {
    private filePath: string;
    private stepFilePath: string;

    constructor(filePath = DEFAULT_PATH, stepFilePath = STEP_CHECKPOINT_PATH) {
        this.filePath = filePath;
        this.stepFilePath = stepFilePath;
    }

    /** Save current state to disk */
    save(bot: Bot, activeTask?: TaskCheckpoint, recentCompletions: string[] = []): void {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const pos = bot.entity?.position;
            const checkpoint: Checkpoint = {
                timestamp: Date.now(),
                botPosition: pos ? { x: pos.x, y: pos.y, z: pos.z } : { x: 0, y: 64, z: 0 },
                inventory: bot.inventory?.items().map((i) => `${i.name} x${i.count}`) ?? [],
                activeTask,
                recentCompletions: recentCompletions.slice(-5),
            };

            fs.writeFileSync(this.filePath, JSON.stringify(checkpoint, null, 2));
        } catch {
            // silently ignore write errors
        }
    }

    /** Load the last saved checkpoint, or null if none exists */
    load(): Checkpoint | null {
        try {
            if (!fs.existsSync(this.filePath)) return null;
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            return JSON.parse(raw) as Checkpoint;
        } catch {
            return null;
        }
    }

    /** Delete the checkpoint (call when a task is fully complete) */
    clear(): void {
        try { fs.unlinkSync(this.filePath); } catch {}
    }

    /** Save step-level checkpoint */
    saveStepCheckpoint(checkpoint: StepCheckpoint): void {
        try {
            const dir = path.dirname(this.stepFilePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            fs.writeFileSync(this.stepFilePath, JSON.stringify(checkpoint, null, 2));
        } catch {
            // silently ignore write errors
        }
    }

    /** Load step-level checkpoint */
    loadStepCheckpoint(): StepCheckpoint | null {
        try {
            if (!fs.existsSync(this.stepFilePath)) return null;
            const raw = fs.readFileSync(this.stepFilePath, 'utf-8');
            return JSON.parse(raw) as StepCheckpoint;
        } catch {
            return null;
        }
    }

    /** Clear step-level checkpoint */
    clearStepCheckpoint(): void {
        try { fs.unlinkSync(this.stepFilePath); } catch {}
    }

    /** Build a task checkpoint from an active executor task */
    static fromTask(task: { type: string; params: Record<string, unknown>; source?: string; createdAt?: number }, bot: Bot, completed = 0): TaskCheckpoint {
        const target = (task.params.count as number) ?? (task.params.maxItems as number) ?? 1;
        const pos = bot.entity?.position;
        return {
            type: task.type,
            params: { ...task.params },
            completed,
            target,
            createdAt: task.createdAt ?? Date.now(),
            startPosition: pos ? { x: pos.x, y: pos.y, z: pos.z } : { x: 0, y: 64, z: 0 },
            source: task.source ?? 'unknown',
        };
    }

    /** Given a checkpointed task, build params to resume it */
    static resumeParams(task: TaskCheckpoint): Record<string, unknown> {
        const remaining = task.target - task.completed;
        return {
            ...task.params,
            count: remaining > 0 ? remaining : 1,
            maxItems: remaining > 0 ? remaining : 1,
        };
    }
}

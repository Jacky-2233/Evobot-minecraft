/**
 * EvoBot v6 Core
 *
 * Initialises: mineflayer bot, pathfinder plugin, skills, executor,
 * perception layer, safety layer, memory layer.
 * Replaces the old bot.js and Agent.js.
 */
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import autoeat from 'mineflayer-auto-eat';
import { Executor } from '../executor/executor.js';
import { StepExecutor } from '../executor/step-executor.js';
import { BaseSkill } from '../skills/base.js';
import { MoveToSkill } from '../skills/movement.js';
import { CollectSkill } from '../skills/collect.js';
import { PickupSkill } from '../skills/pickup.js';
import { RetreatSkill, attackNearestHostile } from '../skills/combat.js';
import { Perception } from '../layers/perception.js';
import { Safety } from '../layers/safety.js';
import { Memory } from '../layers/memory.js';
import {
    BehaviorEngine,
    createWanderBehavior,
    createGatherBehavior,
    createAutoEatBehavior,
    createSocialBehavior,
    createPickupBehavior,
} from '../layers/behavior.js';
import { Planner } from '../layers/planner.js';
import { GapDetector } from '../layers/gap-detector.js';
import { SpecGenerator } from '../layers/spec-generator.js';
import { CheckpointManager } from '../layers/checkpoint.js';
import { PositionHealth } from '../layers/position-health.js';
import { DashboardStateProvider } from '../layers/dashboard-state.js';
import { DashboardServer } from '../web/dashboard.js';
import { nanTracer, isFiniteVec3 } from '../utils/nan-guard.js';
import type { BotConfig, TaskDefinition } from '../types/index.js';

export interface EvoBotCoreOptions {
    config: BotConfig;
    skills?: BaseSkill[];
}

export class EvoBotCore {
    readonly bot: Bot;
    readonly executor: Executor;
    readonly stepExecutor: StepExecutor;
    readonly memory: Memory;
    private config: BotConfig;
    private perception: Perception | null = null;
    private safety: Safety | null = null;
    private positionHealth: PositionHealth | null = null;
    private behavior: BehaviorEngine | null = null;
    private planner: Planner | null = null;
    private gapDetector: GapDetector | null = null;
    private specGenerator: SpecGenerator | null = null;
    private checkpoint: CheckpointManager;
    private dashboardProvider: DashboardStateProvider | null = null;
    private dashboardServer: DashboardServer | null = null;
    private _recentCompletions: string[] = [];
    private intervals: NodeJS.Timeout[] = [];
    private running = false;
    private _reconnecting = false;
    private _reconnectAttempts = 0;
    private _nanSince = 0;

    constructor(options: EvoBotCoreOptions) {
        this.config = options.config;

        this.bot = mineflayer.createBot({
            host: options.config.host,
            port: options.config.port,
            username: options.config.username,
            version: options.config.version,
            auth: options.config.auth,
        });
        this.bot.loadPlugin(pathfinder);
        // auto-eat uses .loader export
        try { this.bot.loadPlugin((autoeat as any).loader || autoeat); } catch {}

        this.executor = new Executor();
        this.memory = new Memory();
        this.checkpoint = new CheckpointManager();
        this.stepExecutor = new StepExecutor(this.bot, this.checkpoint);

        // DashboardStateProvider — fed references later in onSpawn
        this.dashboardProvider = new DashboardStateProvider(
            this.bot,
            null, // positionHealth not ready yet
            this.checkpoint,
            null, // gapDetector not ready yet
            this.memory,
            this.executor,
            Date.now(),
            this.stepExecutor,
        );

        // Register default skills
        this.executor.registerSkill(new MoveToSkill(this.bot));
        this.executor.registerSkill(new CollectSkill(this.bot));
        this.executor.registerSkill(new PickupSkill(this.bot));
        this.executor.registerSkill(new RetreatSkill(this.bot));

        // Register user-provided skills
        if (options.skills) {
            for (const skill of options.skills) {
                this.executor.registerSkill(skill);
            }
        }

        this.setupEvents();
    }

    private setupEvents(): void {
        this.bot.once('spawn', () => this.onSpawn());
        this.bot.on('login', () => console.log('[Core] Logged in'));
        this.bot.on('end', () => this.onEnd());
        this.bot.on('error', (err: Error) => console.error('[Core] Bot error:', err.message));
    }

    private onSpawn(): void {
        console.log('[Core] Spawned');
        this.running = true;

        // Pathfinder movements
        const mcData = require('minecraft-data')(this.bot.version);
        const { Movements } = require('mineflayer-pathfinder');
        const moves = new Movements(this.bot, mcData);
        moves.canDig = false;
        this.bot.pathfinder.setMovements(moves);

        // Auto-eat: eat when hungry (appears more human-like to server)
        try {
            const auto = this.bot as any;
            if (auto.autoEat) {
                auto.autoEat.options = {
                    priority: 'food',
                    startAt: this.config.hungerThreshold,
                    bannedFood: ['rotten_flesh', 'poisonous_potato', 'spider_eye', 'pufferfish'],
                };
                auto.autoEat.enable();
            }
        } catch {}

        // ─── Resume from checkpoint ──────────────────────
        const saved = this.checkpoint.load();
        if (saved?.activeTask && saved.activeTask.target > saved.activeTask.completed) {
            console.log(`[Core] Resuming task: ${saved.activeTask.type} (${saved.activeTask.completed}/${saved.activeTask.target} done)`);
            const resumeParams = CheckpointManager.resumeParams(saved.activeTask);
            this.addTask({
                type: saved.activeTask.type,
                params: resumeParams,
                priority: 25, // higher than normal idle to finish first
                source: 'resume' as any,
            });
            this._recentCompletions = saved.recentCompletions ?? [];
        } else {
            this.checkpoint.clear();
            this._recentCompletions = [];
        }

        // ─── Position Health ────────────────────────────
        this.positionHealth = new PositionHealth(this.bot, {
            degradedDurationMs: 3000,
            spawnDegradedMs: 5000,
        });
        this.positionHealth.markSpawned();

        // ─── Layers ──────────────────────────────────────
        this.perception = new Perception(this.bot, {
            hostileRadius: 12,
            blockScanRadius: 10,
        });
        this.safety = new Safety(this.bot, this.perception, {
            hungerThreshold: this.config.hungerThreshold,
            lowHealthThreshold: this.config.lowHealthThreshold,
            criticalHealthThreshold: this.config.criticalHealthThreshold,
            stuckTimeoutMs:             this.config.stuckTimeoutMs,
            hostileEvadeDistance: 12,
        });
        this.safety.markSpawned();

        // Wire executor → memory + checkpoint + events
        this.executor.onTaskStart = (task) => {
            this.dashboardProvider?.pushEvent('task_start', `${task.type}`);
        };
        this.executor.onComplete = (result) => {
            this.memory.recordTask(result);
            const evType = result.result.ok ? 'task_ok' : 'task_fail';
            this.dashboardProvider?.pushEvent(evType, `${result.task.type}: ${result.result.detail}`);
            // Track recent completions
            if (result.result.ok) {
                this._recentCompletions.push(`${result.task.type}: ${result.result.detail}`);
                if (this._recentCompletions.length > 5) this._recentCompletions.shift();
            }
            // Parse collected count from result detail (e.g. "Collected 2/2 jungle_log"
            // or "Picked up 3 items" or "Partial: 1/5 logs")
            const detail = result.result.detail;
            const countMatch = detail.match(/(\d+)\/(\d+)/);
            if (countMatch && result.task.params) {
                const completed = parseInt(countMatch[1]);
                const target = parseInt(countMatch[2]);
                if (completed >= target) {
                    // Task fully done — clear checkpoint
                    this.checkpoint.clear();
                } else {
                    // Partial progress — save for resume
                    const ckpt = CheckpointManager.fromTask(result.task, this.bot, completed);
                    this.checkpoint.save(this.bot, ckpt, this._recentCompletions);
                }
            } else {
                // Non-counted task — clear any active checkpoint since task is done
                if (result.result.ok) {
                    this.checkpoint.clear();
                } else {
                    this.checkpoint.save(this.bot, undefined, this._recentCompletions);
                }
            }
        };

        // Wire step executor → dashboard + memory
        this.stepExecutor.onStepComplete = (record) => {
            const evType = record.result.ok ? 'step_ok' : 'step_fail';
            this.dashboardProvider?.pushEvent(evType, `${record.sequenceName}:${record.stepName} - ${record.result.detail}`);
        };
        this.stepExecutor.onSequenceComplete = (sequence, result) => {
            this.dashboardProvider?.pushEvent('sequence_complete', `${sequence.name}: ${result.detail}`);
            // Record as task completion
            this.memory.recordTask({
                task: {
                    id: sequence.id,
                    type: sequence.originalTaskType ?? 'step_sequence',
                    params: sequence.originalTaskParams ?? {},
                    priority: 30,
                    createdAt: sequence.createdAt,
                    source: 'step_executor',
                },
                result,
                elapsedMs: Date.now() - sequence.createdAt,
                retries: 0,
            });
        };

        // ─── Behavior Engine ────────────────────────────
        const deps = {
            bot: this.bot,
            perception: this.perception,
            memory: this.memory,
            executor: this.executor,
        };
        const hungerThreshold = this.config.hungerThreshold;
        this.behavior = new BehaviorEngine();
        this.behavior.register(createAutoEatBehavior({ ...deps, hungerThreshold } as any));
        this.behavior.register(createGatherBehavior(deps));
        this.behavior.register(createPickupBehavior(deps));
        this.behavior.register(createWanderBehavior(deps));
        this.behavior.register(createSocialBehavior(deps));
        this.behavior.start();

        // ─── Planner ─────────────────────────────────────
        this.planner = new Planner({
            bot: this.bot,
            perception: this.perception!,
            memory: this.memory,
            executor: this.executor,
            config: this.config,
        });

        // ─── Gap Detector ────────────────────────────────
        this.gapDetector = new GapDetector(this.memory, {
            minSamples: 3,
            analysisIntervalMs: 600000,
        });

        // ─── Spec Generator ──────────────────────────────
        this.specGenerator = new SpecGenerator();

        // ─── Dashboard ──────────────────────────────────
        // Re-create provider with now-ready references
        this.dashboardProvider = new DashboardStateProvider(
            this.bot,
            this.positionHealth,
            this.checkpoint,
            this.gapDetector,
            this.memory,
            this.executor,
            Date.now(),
            this.stepExecutor,
        );
        // Only start dashboard server once (not on reconnects)
        if (!this.dashboardServer) {
            this.dashboardServer = new DashboardServer(this.dashboardProvider, 3000);
            this.dashboardServer.start();
        }

        // Gap analysis — every 5 minutes
        this.intervals.push(
            setInterval(() => {
                if (!this.running) return;
                this.gapDetector?.tick();
            }, 300000),
        );

        // Periodic checkpoint save — every 5 seconds
        this.intervals.push(
            setInterval(() => {
                if (!this.running || !this.bot.entity) return;
                const curTask = this.executor.getCurrentTask();
                const activeCkpt = curTask
                    ? CheckpointManager.fromTask(curTask, this.bot)
                    : undefined;
                this.checkpoint.save(this.bot, activeCkpt, this._recentCompletions);
            }, 5000),
        );

        // ─── Main Tick Loop ─────────────────────────────
        this.intervals.push(
            setInterval(async () => {
                if (!this.running) return;

                // 0. Position health check — gate all movement/attack
                this.positionHealth!.evaluate();
                const ph = this.positionHealth!;

                // NaN guard — 2s tolerance, not instant disconnect
                const pos = this.bot.entity.position;
                if (Number.isNaN(pos.x) || Number.isNaN(pos.y) || Number.isNaN(pos.z)) {
                    if (this._nanSince === 0) {
                        this._nanSince = Date.now();
                        console.warn('[Core] Position NaN — waiting for stabilization');
                        this.bot.pathfinder?.stop();
                        this.bot.clearControlStates();
                        return;
                    }
                    if (Date.now() - this._nanSince > 2000) {
                        console.error('[Core] Position NaN persisted 2s — forcing reconnect');
                        this.shutdown();
                        this.reconnect();
                        return;
                    }
                } else {
                    this._nanSince = 0;
                }

                // 1. Perception: refresh world state
                const summary = this.perception!.scan();

                // 2. Safety: check danger conditions
                this.safety!.tick(this.executor);

                // 3. If safety is overriding OR position invalid, pause behavior + cancel current task
                if (this.safety!.isOverriding || !ph.canMove) {
                    this.behavior?.pause();
                    if (!ph.canMove) {
                        // Position invalid — cancel current executor task immediately
                        this.executor.clear();
                    }
                } else {
                    this.behavior?.resume();
                    await this.behavior!.tick();
                    await this.executor.tick();
                }

                // 4. Dashboard tick — broadcast state to web clients
                this.dashboardServer?.tick();
            }, this.config.updateIntervalMs),
        );

        // Status logging
        this.intervals.push(
            setInterval(() => {
                if (!this.running || !this.bot.entity) return;
                const p = this.bot.entity.position;
                const summary = this.perception?.summary;
                const hostileStr = summary
                    ? `Hostile=${summary.nearbyHostile.length}`
                    : '';
                const safetyStr = this.safety?.isOverriding
                    ? ` SAFETY:${this.safety.recoveryPhase}`
                    : '';
                const behavStr = this.behavior?.activeName
                    ? ` Beh:${this.behavior.activeName}`
                    : '';
                const phStr = this.positionHealth ? ` PH:${this.positionHealth.state[0]}` : '';
                console.log(
                    `[Core] HP=${this.bot.health.toFixed(0)} Food=${this.bot.food.toFixed(0)} ` +
                    `Pos=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) ` +
                    `${hostileStr} Mem=${this.memory.size} ` +
                    `Queue=${this.executor.getQueueDepth()}${safetyStr}${behavStr}${phStr}`,
                );
            }, 10000),
        );

        // BlockAt heartbeat — prevents physics NaN race
        this.intervals.push(
            setInterval(() => {
                if (this.bot?.entity) {
                    this.bot.blockAt(this.bot.entity.position);
                }
            }, 2000),
        );

        // Physics-tick NaN guard — 2s tolerance before reconnect
        this._nanSince = 0;
        this.bot.on('physicsTick', () => {
            if (!this.bot?.entity) return;
            const p = this.bot.entity.position;
            if (Number.isNaN(p.x) || Number.isNaN(p.y) || Number.isNaN(p.z)) {
                if (this._nanSince === 0) {
                    this._nanSince = Date.now();
                    this.dashboardProvider?.pushEvent('nan_detected', 'physicsTick NaN — stabilizing');
                    console.warn('[Core] physicsTick NaN detected — waiting for stabilization');
                    nanTracer.dump('physicsTick NaN');
                    this.bot.pathfinder?.stop();
                    this.bot.clearControlStates();
                    try {
                        this.bot.entity.velocity.x = 0;
                        this.bot.entity.velocity.y = 0;
                        this.bot.entity.velocity.z = 0;
                    } catch {}
                } else if (Date.now() - this._nanSince > 2000) {
                    console.error('[Core] physicsTick NaN persisted 2s — forcing reconnect');
                    this.shutdown();
                    this.reconnect();
                }
            } else {
                if (this._nanSince > 0) {
                    console.log('[Core] physicsTick NaN cleared');
                }
                this._nanSince = 0;
            }
        });

        setTimeout(() => {
            if (this.bot?.chat) this.bot.chat('EvoBot v6 online');
        }, 2000);

        // ─── Trace server-sent position updates (root cause of NaN) ──
        this.bot.on('entityMoved', (entity: any) => {
            if (!entity?.position) return;
            const p = entity.position;
            if (Number.isNaN(p.x) || Number.isNaN(p.y) || Number.isNaN(p.z)) {
                nanTracer.trace('entityMoved NaN', { entity: entity.name ?? entity.id });
            }
        });

        // Track our own position changes from server
        let lastSelfPos = this.bot.entity.position.clone();
        this.bot.on('move', () => {
            const p = this.bot.entity.position;
            if (Number.isNaN(p.x) || Number.isNaN(p.y) || Number.isNaN(p.z)) {
                nanTracer.trace('self move NaN', { lastPos: lastSelfPos });
            }
            if (isFiniteVec3(p)) {
                lastSelfPos = p.clone();
            }
        });

        // ─── Real-time Damage Response ──────────────────
        let prevHealth = this.bot.health;
        this.bot.on('health', () => {
            if (!this.running) return;
            try {
                const now = this.bot.health;

                if (now < prevHealth) {
                    console.warn(`[Core] Damaged! HP ${prevHealth.toFixed(0)} → ${now.toFixed(0)}`);
                    this.dashboardProvider?.pushEvent('damaged', `HP ${prevHealth.toFixed(0)} → ${now.toFixed(0)}`);
                    this.positionHealth?.markDamaged();
                    nanTracer.trace('damaged', { hpFrom: prevHealth, hpTo: now, pos: this.bot.entity.position });

                    // Stop pathfinding before attacking to avoid physics conflicts
                    this.bot.pathfinder?.stop();
                    nanTracer.trace('pathfinder.stop (damage)');

                    // Try to attack the nearest hostile within melee range
                    attackNearestHostile(this.bot);
                    nanTracer.trace('attackNearestHostile called');

                    // If health is low, trigger immediate safety check
                    if (now <= this.config.lowHealthThreshold) {
                        this.safety?.onDamaged(this.executor);
                        nanTracer.trace('safety.onDamaged');
                    }
                }
                prevHealth = now;
            } catch (err: unknown) {
                console.warn('[Core] Health handler error:', (err as Error).message);
            }
        });

        this.bot.on('death', () => {
            console.warn('[Core] Died!');
            this.memory.recordFact('Died', { position: this.bot.entity?.position });
            this.executor.clear();
            this.bot.pathfinder?.stop();
            this.bot.clearControlStates();
            this.safety?.markSpawned();
            // Mineflayer handles auto-respawn
        });
    }

    private onEnd(): void {
        console.log('[Core] Disconnected');
        this.dashboardProvider?.pushEvent('disconnect', 'Server disconnected');
        // Save checkpoint before disconnect
        const curTask = this.executor.getCurrentTask();
        const activeCkpt = curTask
            ? CheckpointManager.fromTask(curTask, this.bot)
            : undefined;
        this.checkpoint.save(this.bot, activeCkpt, this._recentCompletions);

        if (this.config.autoReconnect && this.running && !this._reconnecting) {
            this.reconnect();
        }
    }

    private reconnect(): void {
        if (this._reconnecting) return;
        this._reconnecting = true;
        this._reconnectAttempts++;
        this.intervals.forEach(clearInterval);
        this.intervals = [];
        this.running = false;

        const delay = Math.min(5000 * Math.pow(2, Math.min(this._reconnectAttempts, 5)), 120000);
        console.log(`[Core] Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this._reconnectAttempts})...`);

        setTimeout(() => {
            // Full restart — create new EvoBotCore instance
            // and replace internals properly
            this.executor.clear();
            this.stepExecutor.cancel(); // Cancel any running step sequence
            this.perception = null;
            this.safety = null;
            this.behavior?.stop();
            this.behavior = null;
            this.planner = null;

            try { this.bot.removeAllListeners(); } catch {}
            try { this.bot.quit(); } catch {}

            const newBot = mineflayer.createBot({
                host: this.config.host,
                port: this.config.port,
                username: this.config.username,
                version: this.config.version,
                auth: this.config.auth,
            });
            newBot.loadPlugin(pathfinder);
            try { newBot.loadPlugin((autoeat as any).loader || autoeat); } catch {}

            // Re-assign bot and re-init handlers
            (this as any).bot = newBot;
            this.executor.registerSkill(new MoveToSkill(newBot));
            this.executor.registerSkill(new CollectSkill(newBot));
            this.executor.registerSkill(new PickupSkill(newBot));
            this.executor.registerSkill(new RetreatSkill(newBot));

            newBot.once('spawn', () => {
                this._reconnecting = false;
                this._reconnectAttempts = 0; // reset on successful spawn
                this.dashboardProvider?.pushEvent('reconnect', 'Reconnected after ' + (delay/1000).toFixed(0) + 's');
                this.onSpawn();
            });
            newBot.on('login', () => console.log('[Core] Logged in'));
            newBot.on('end', () => this.onEnd());
            newBot.on('error', (err: Error) => console.error('[Core] Bot error:', err.message));
        }, delay);
    }

    /** Programmatic: add a task to the executor */
    addTask(task: Omit<TaskDefinition, 'id' | 'createdAt'>): string {
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        this.executor.enqueue({
            id,
            ...task,
            createdAt: Date.now(),
        });
        return id;
    }

    /** Execute a step sequence (atomic steps for 8s connection windows) */
    async executeStepSequence(sequence: import('../types/index.js').StepSequence): Promise<import('../types/index.js').SkillResult> {
        return this.stepExecutor.execute(sequence);
    }

    /** Plan and execute a high-level goal via LLM */
    async plan(goal: string): Promise<{ success: boolean; detail: string }> {
        if (!this.planner) return { success: false, detail: 'Planner not initialized' };
        return this.planner.planAndExecute(goal);
    }

    /** Run gap analysis and return formatted report */
    analyzeGaps(windowMinutes = 10, format: 'text' | 'json' | 'top' = 'text'): string {
        if (!this.gapDetector) return 'Gap Detector not initialized';
        const report = this.gapDetector.analyze(windowMinutes * 60000);
        switch (format) {
            case 'json':
                return JSON.stringify(report, null, 2);
            case 'top': {
                const top = report.findings.slice(0, 3);
                return this.gapDetector.formatReport({ ...report, findings: top });
            }
            default:
                return this.gapDetector.formatReport(report);
        }
    }

    /** Convert the first skill_gap finding in the report to a SkillSpec */
    generateSpecFromGaps(windowMinutes = 10): string {
        if (!this.gapDetector || !this.specGenerator) return 'Spec Generator not initialized';
        const report = this.gapDetector.analyze(windowMinutes * 60000);
        const skillGaps = report.findings.filter((f) => f.category === 'skill_gap');
        if (skillGaps.length === 0) return 'No skill gap findings in report.';

        const specs = this.specGenerator.generateAll(skillGaps);
        return JSON.stringify(specs, null, 2);
    }

    shutdown(): void {
        this.running = false;
        this.intervals.forEach(clearInterval);
        this.intervals = [];
        this.executor.clear();
        try {
            this.bot.removeAllListeners();
            this.bot.quit();
        } catch {}
    }
}

import mineflayer, { Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import autoeat from 'mineflayer-auto-eat';
import fs from 'fs';
import path from 'path';
import { MoveToSkill, type MoveParams } from '../skills/movement.js';
import { CollectSkill, type CollectParams } from '../skills/collect.js';
import { EatSkill } from '../skills/eat.js';
import { RetreatSkill, attackNearestHostile } from '../skills/retreat.js';
import { CraftSkill } from '../skills/craft.js';
import { CraftChainSkill, listCraftChains } from '../skills/craft-chain.js';
import { initLLM, callLLM, getModel, getProvider, setModel, setProviderKey, listModels } from '../utils/llm.js';
import { isFiniteVec3 } from '../utils/nan-guard.js';
import type { BotConfig, SkillResult } from '../types/index.js';
import { SkillLibrary } from '../memory/skill-library.js';
import { ExampleLibrary } from '../memory/example-library.js';
import { FailureMemory } from '../memory/failure-memory.js';
import { TaskPlannerContext } from '../planner/task-planner.js';
import { captureTaskSnapshot, verifyTask } from '../planner/verifier.js';
import { buildSubgoalPlan } from '../planner/subgoal-planner.js';
import { createWebKnowledgeProvider, type WebKnowledgeProvider } from '../utils/web-knowledge.js';

let _GoalNear: any = null;
function getGoalNear(): any {
    if (_GoalNear) return _GoalNear;
    try {
        _GoalNear = require('mineflayer-pathfinder').goals.GoalNear;
        if (!_GoalNear) console.error('[V7] GoalNear is undefined after require');
    } catch (e) {
        console.error('[V7] Failed to load GoalNear:', (e as Error).message);
    }
    return _GoalNear;
}

type AnySkill = MoveToSkill | CollectSkill | EatSkill | RetreatSkill | CraftSkill | CraftChainSkill;
type TaskItem = { type: string; params: any; retries: number };
type RuntimeTask = {
    id: string;
    type: 'follow_player';
    status: 'running' | 'paused' | 'interrupted' | 'failed';
    targetPlayer: string;
    desiredDistance: number;
    tolerance: number;
    maxChaseDistance: number;
    lastKnownTargetPos?: { x: number; y: number; z: number };
    interruptReason?: string;
    lastError?: string;
    resumeAfterInterrupt: boolean;
    retries: number;
    updatedAt: number;
} | {
    id: string;
    type: 'search_target';
    status: 'running' | 'paused' | 'interrupted' | 'failed';
    targetName: string;
    targetKind: 'entity' | 'block';
    searchRadius: number;
    maxSearchDistance: number;
    exploreStepDistance: number;
    exploredSteps: number;
    anchorPos: { x: number; y: number; z: number };
    lastKnownTargetPos?: { x: number; y: number; z: number };
    interruptReason?: string;
    lastError?: string;
    resumeAfterInterrupt: boolean;
    onFoundAction?: { type: string; params: any } | null;
    retries: number;
    updatedAt: number;
};
type GoalAssessment = {
    userRequest: string;
    intent: string;
    confidence: number;
    supported: boolean;
    reason?: string;
    suggestedFallback?: string;
    updatedAt: number;
};
type LastFailure = {
    taskType: string;
    params: any;
    detail: string;
    failureType?: string;
    at: number;
};

export class EvoBotV7 {
    readonly bot: Bot;
    private config: BotConfig;
    private skills = new Map<string, AnySkill>();
    private running = false;
    private _taskQueue: TaskItem[] = [];
    private _prevHealth = 20;
    private _reconnectAttempts = 0;
    private _inWater = false;
    private _lastEvent = '';
    private _logDir = 'logs';
    private _loopTimer: NodeJS.Timeout | null = null;
    private _emergencyActive = false;
    private _currentTask: TaskItem | null = null;
    private _lastPlannedAction: { type: string; params: any } | null = null;
    private _runtimeTask: RuntimeTask | null = null;
    private _lastFollowGoalUpdateMs = 0;
    private _lastFollowTargetSnapshot: { x: number; y: number; z: number } | null = null;
    private _lastGoalAssessment: GoalAssessment | null = null;
    private _lastSearchGoalUpdateMs = 0;
    private _lastFailure: LastFailure | null = null;
    private readonly _skillLibrary = new SkillLibrary();
    private readonly _exampleLibrary = new ExampleLibrary();
    private readonly _failureMemory = new FailureMemory();
    private readonly _plannerContext = new TaskPlannerContext(this._skillLibrary, this._exampleLibrary, this._failureMemory);
    private readonly _webKnowledge: WebKnowledgeProvider = createWebKnowledgeProvider();

    // Decision/movement pacing (prevents erratic running)
    private _lastDecisionMs = 0;
    private _lastArrivalMs = 0;
    private _lastMoveTarget: { x: number; y: number; z: number } | null = null;
    private readonly _decisionCooldownMs = 2000;
    private readonly _arrivalCooldownMs = 1500;

    constructor(config: BotConfig) {
        this.config = config;
        this.bot = mineflayer.createBot({
            host: config.host, port: config.port, username: config.username,
            version: config.version, auth: config.auth,
        });
        this.bot.loadPlugin(pathfinder);
        try { this.bot.loadPlugin((autoeat as any).loader || autoeat); } catch {}

        this.register(new MoveToSkill(this.bot));
        this.register(new CollectSkill(this.bot));
        this.register(new EatSkill(this.bot));
        this.register(new RetreatSkill(this.bot));
        this.register(new CraftSkill(this.bot));
        this.register(new CraftChainSkill(this.bot));

        initLLM(config);
        this.bindBotEvents(this.bot);
    }

    private register(s: AnySkill): void { this.skills.set(s.name, s); }

    private _log(filename: string, data: Record<string, unknown>): void {
        try {
            const dir = path.join(process.cwd(), this._logDir);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(path.join(dir, filename), JSON.stringify({ ts: Date.now(), ...data }) + '\n');
        } catch {}
    }

    getModel(): string { return getModel(); }
    getProvider(): string { return getProvider(); }
    setModel(name: string): void { setModel(name); }
    setProviderKey(provider: string, key: string): void { setProviderKey(provider, key); }
    hasAnyProviderKey(): boolean {
        const providers = this.config.ai.providers || {};
        return Object.values(providers).some((p: any) => typeof p?.apiKey === 'string' && p.apiKey.trim().length > 0);
    }
    listModels(): string { return listModels(); }
    listCraftChains(): string { return listCraftChains(); }
    submitTask(type: string, params: any): void { this._taskQueue.push({ type, params, retries: 0 }); }
    chat(message: string): void { this.bot.chat(message); }
    queueTask(type: string, params: any): void { this._taskQueue.push({ type, params, retries: 0 }); }
    replaceWithTask(type: string, params: any): void { this._taskQueue = [{ type, params, retries: 0 }]; }
    followPlayer(player?: string, distance = 12, tolerance = 2, maxDistance = 100): void {
        this.applyFollowTask(player ?? '', distance, tolerance, maxDistance);
    }
    searchTarget(target: string, kind: 'entity' | 'block' = 'entity', radius = 24, maxDistance = 100, stepDistance = 12): void {
        this.applySearchTask(target, kind, radius, maxDistance, stepDistance, this.defaultFollowupActionForSearch(target, kind));
    }
    clearRuntimeTask(): void {
        this._runtimeTask = null;
        this._lastFollowGoalUpdateMs = 0;
        this._lastFollowTargetSnapshot = null;
        this._lastSearchGoalUpdateMs = 0;
        try { this.bot.pathfinder?.stop(); } catch {}
    }
    stopAll(): void {
        this.clearRuntimeTask();
        this._taskQueue = [];
        try { this.bot.pathfinder?.stop(); } catch {}
        try { this.bot.clearControlStates(); } catch {}
        this._lastEvent = 'STOP all work';
    }
    getScanSummary(query?: string, radius = 24): string {
        const q = (query ?? '').toLowerCase();
        const players = this.findNearbyPlayers(radius)
            .filter(p => !q || p.name.toLowerCase().includes(q))
            .map(p => `${p.name}@(${p.x},${p.y},${p.z}) ${p.distance.toFixed(1)}m`).join(', ') || 'none';
        const entities = this.findNearbyEntities(radius, 10)
            .filter(e => !q || e.name.toLowerCase().includes(q))
            .map(e => `${e.name}@(${e.x},${e.y},${e.z}) ${e.distance.toFixed(1)}m`).join(', ') || 'none';
        const blocks = this.findNearbyBlocks(radius, 10)
            .filter(b => !q || b.name.toLowerCase().includes(q))
            .map(b => `${b.name}@(${b.x},${b.y},${b.z})`).join(', ') || 'none';
        return [`Players: ${players}`, `Entities: ${entities}`, `Blocks: ${blocks}`].join('\n');
    }
    getPlayersSummary(radius = 48): string {
        const players = this.findNearbyPlayers(radius);
        if (players.length === 0) return 'Players: none';
        return ['Players:'].concat(players.map(p => `- ${p.name} @ (${p.x}, ${p.y}, ${p.z}) ${p.distance.toFixed(1)}m`)).join('\n');
    }
    getEntitiesSummary(radius = 24, limit = 12): string {
        const entities = this.findNearbyEntities(radius, limit);
        if (entities.length === 0) return 'Entities: none';
        return ['Entities:'].concat(entities.map(e => `- ${e.name} @ (${e.x}, ${e.y}, ${e.z}) ${e.distance.toFixed(1)}m`)).join('\n');
    }
    getBlocksSummary(radius = 24, limit = 12): string {
        const blocks = this.findNearbyBlocks(radius, limit);
        if (blocks.length === 0) return 'Blocks: none';
        return ['Blocks:'].concat(blocks.map(b => `- ${b.name} @ (${b.x}, ${b.y}, ${b.z})`)).join('\n');
    }
    getTasksSummary(): string {
        const runtimeTask = this._runtimeTask
            ? this._runtimeTask.type === 'follow_player'
                ? `runtime: follow_player target=${this._runtimeTask.targetPlayer} dist=${this._runtimeTask.desiredDistance} tol=${this._runtimeTask.tolerance} status=${this._runtimeTask.status}`
                : `runtime: search_target target=${this._runtimeTask.targetName} kind=${this._runtimeTask.targetKind} explored=${this._runtimeTask.exploredSteps} status=${this._runtimeTask.status}`
            : 'runtime: none';
        const queued = this._taskQueue.length > 0
            ? this._taskQueue.map((t, i) => `${i + 1}. ${t.type} ${JSON.stringify(t.params)}${t.retries > 0 ? ` retries=${t.retries}` : ''}`).join('\n')
            : 'queue: empty';
        const current = this._currentTask ? `current: ${this._currentTask.type} ${JSON.stringify(this._currentTask.params)}` : 'current: none';
        return [runtimeTask, current, queued].join('\n');
    }
    getMemorySummary(query = ''): string {
        const state = this.buildStatePrompt();
        return [
            `Skill library: ${this._skillLibrary.list()}`,
            this._plannerContext.build(query || state, state),
        ].join('\n');
    }
    async getWebKnowledgeSummary(query: string): Promise<string> {
        const results = await this._webKnowledge.query(query);
        if (results.length === 0) return 'Web knowledge: none or disabled';
        return ['Web knowledge:'].concat(results.slice(0, 5).map((r) => `- ${r.source}: ${r.text}`)).join('\n');
    }
    getStatusSummary(): string {
        const pos = this.bot.entity?.position;
        const posStr = pos ? `(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)})` : '(?, ?, ?)';
        const current = this._currentTask ? `${this._currentTask.type} ${JSON.stringify(this._currentTask.params)}` : 'none';
        const queued = this._taskQueue.length > 0
            ? this._taskQueue.map(t => `${t.type}${t.retries > 0 ? `#${t.retries}` : ''}`).join(', ')
            : 'empty';
        const lastPlan = this._lastPlannedAction ? `${this._lastPlannedAction.type} ${JSON.stringify(this._lastPlannedAction.params)}` : 'none';
        const lastMove = this._lastMoveTarget ? `(${this._lastMoveTarget.x}, ${this._lastMoveTarget.y}, ${this._lastMoveTarget.z})` : 'none';
        const runtimeTask = this._runtimeTask
            ? this._runtimeTask.type === 'follow_player'
                ? `${this._runtimeTask.type} target=${this._runtimeTask.targetPlayer} dist=${this._runtimeTask.desiredDistance} tol=${this._runtimeTask.tolerance} status=${this._runtimeTask.status}${this._runtimeTask.interruptReason ? ` interrupt=${this._runtimeTask.interruptReason}` : ''}`
                : `${this._runtimeTask.type} target=${this._runtimeTask.targetName} kind=${this._runtimeTask.targetKind} radius=${this._runtimeTask.searchRadius} max=${this._runtimeTask.maxSearchDistance} step=${this._runtimeTask.exploreStepDistance} explored=${this._runtimeTask.exploredSteps} status=${this._runtimeTask.status}${this._runtimeTask.interruptReason ? ` interrupt=${this._runtimeTask.interruptReason}` : ''}`
            : 'none';
        const goalAssessment = this._lastGoalAssessment
            ? `${this._lastGoalAssessment.intent} supported=${this._lastGoalAssessment.supported} conf=${this._lastGoalAssessment.confidence}${this._lastGoalAssessment.reason ? ` reason=${this._lastGoalAssessment.reason}` : ''}`
            : 'none';
        return [
            `Pos: ${posStr}`,
            `Runtime task: ${runtimeTask}`,
            `Last goal assessment: ${goalAssessment}`,
            `Last failure: ${this._lastFailure ? `${this._lastFailure.taskType} ${this._lastFailure.failureType ?? 'unknown'} ${this._lastFailure.detail}` : 'none'}`,
            `Current task: ${current}`,
            `Queued: ${queued}`,
            `Last AI plan: ${lastPlan}`,
            `Last move target: ${lastMove}`,
            `Last event: ${this._lastEvent || 'none'}`,
        ].join('\n');
    }

    private bindBotEvents(bot: Bot): void {
        bot.once('spawn', () => this.onSpawn());
        bot.on('end', () => this.onEnd());
        bot.on('error', (e: Error) => console.error(`[V7] ${e.message}`));
        bot.on('health', () => {
            const hp = bot.health;
            if (hp < this._prevHealth && hp <= this.config.lowHealthThreshold) {
                bot.pathfinder?.stop();
                attackNearestHostile(bot);
            }
            this._prevHealth = hp;
        });
        bot.on('death', () => {
            console.warn('[V7] Died');
            this.execClear();
        });
        bot.on('chat', (username: string, msg: string) => {
            if (username === bot.username) return;
            this.handleChat(username, msg).catch(e => console.error('[V7] Chat handler error:', (e as Error).message));
        });
    }

    private async onSpawn(): Promise<void> {
        console.log('[V7] Spawned');
        this.running = true;
        this._reconnectAttempts = 0;

        const registry = this.bot.registry;
        if (!registry) {
            console.error('[V7] bot.registry is null, cannot configure pathfinder');
            return;
        }
        const { Movements } = require('mineflayer-pathfinder');
        const moves = new Movements(this.bot);
        moves.canDig = false;
        moves.allowParkour = false;
        moves.allowSprinting = false; // less overshoot near edges/water
        moves.liquidCost = 100; // strongly discourage paths through water
        moves.infiniteLiquidDropdownDistance = false; // don't drop into water from height
        // Avoid walking into water/lava
        const water = registry.blocksByName['water']?.id;
        const lava = registry.blocksByName['lava']?.id;
        if (water) moves.blocksToAvoid.add(water);
        if (lava) moves.blocksToAvoid.add(lava);
        this.bot.pathfinder.setMovements(moves);

        try {
            const auto = this.bot as any;
            if (auto.autoEat) {
                auto.autoEat.options = { priority: 'food', startAt: this.config.hungerThreshold, bannedFood: ['rotten_flesh'] };
                auto.autoEat.enable();
            }
        } catch {}

        setTimeout(() => this.bot?.chat?.('EvoBot v7 online'), 2000);
        this.startLoop();
    }

    private startLoop(): void {
        if (this._loopTimer) clearTimeout(this._loopTimer);
        const tick = async () => {
            if (!this.running) return;
            try { await this.tick(); } catch (e) { console.error('[V7] Tick error:', (e as Error).message); }
            this._loopTimer = setTimeout(tick, this.config.updateIntervalMs);
        };
        tick();
    }

    private async tick(): Promise<void> {
        const pos = this.bot.entity?.position;
        if (!pos || !isFiniteVec3(pos)) return;

        // ── Safety (hardcoded, no AI) ──
        const feet = this.bot.blockAt(pos);
        const head = this.bot.blockAt(pos.offset(0, 1, 0));
        const inWater = (feet?.name?.includes('water') ?? false) || (head?.name?.includes('water') ?? false);
        if (inWater) {
            if (!this._inWater) {
                this._inWater = true;
                console.warn('[V7] In water — swimming up');
                this.bot.pathfinder?.stop();
                this.interruptRuntimeTask('water_escape');
            }
            // Swim up until head is above water
            this.bot.setControlState('forward', false);
            this.bot.setControlState('back', false);
            this.bot.setControlState('left', false);
            this.bot.setControlState('right', false);
            this.bot.setControlState('sprint', false);
            this.bot.setControlState('sneak', false);
            this.bot.setControlState('jump', true);
            try { this.bot.look(this.bot.entity.yaw, -Math.PI / 2, true); } catch {}
            return;
        }
        if (this._inWater) {
            this._inWater = false;
            this.bot.setControlState('jump', false);
            console.log('[V7] Out of water');
            this.resumeRuntimeTaskIfPossible('water_escape');
        }

        const health = this.bot.health ?? 20;
        if (health <= this.config.criticalHealthThreshold) {
            if (!this._emergencyActive) {
                this._emergencyActive = true;
                try {
                    this.interruptRuntimeTask('critical_health');
                    const result = await this.runSkill('retreat', { distance: 16 });
                    this._lastEvent = `${result.ok ? 'OK' : 'FAIL'} retreat: ${result.detail}`;
                } finally {
                    this.resumeRuntimeTaskIfPossible('critical_health');
                    this._emergencyActive = false;
                }
            }
            return;
        }

        // ── Execute queued tasks ──
        if (this._taskQueue.length > 0) {
            const task = this._taskQueue[0];
            this._currentTask = task;
            const result = await this.runSkill(task.type, task.params);
            console.log(`[V7] ${result.ok ? 'OK' : 'FAIL'} ${task.type}: ${result.detail}`);
            this._lastEvent = `${result.ok ? 'OK' : 'FAIL'} ${task.type}: ${result.detail}`;
            if (result.ok) {
                this._lastFailure = null;
            } else {
                this._lastFailure = {
                    taskType: task.type,
                    params: task.params,
                    detail: result.detail,
                    failureType: result.failureType,
                    at: Date.now(),
                };
            }
            if (result.ok) {
                this._taskQueue.shift();
            } else if (this.isRetryableFailure(result) && task.retries < 2) {
                task.retries++;
                console.warn(`[V7] Retrying ${task.type} (${task.retries}/2)`);
            } else {
                this._taskQueue.shift();
            }
            if (result.ok && task.type === 'move_to') {
                this._lastMoveTarget = { x: task.params.x, y: task.params.y, z: task.params.z };
                this._lastArrivalMs = Date.now();
            }
            this._currentTask = null;
            return;
        }

        if (await this.tickRuntimeTask()) return;

        // Deterministic early-game fallback: if wood is visible and inventory is short on wood/planks,
        // collect it before asking the LLM to freeform explore.
        const nearbyLog = this.bot.findBlock({ matching: (b: any) => b?.name?.includes('log') ?? false, maxDistance: 10 });
        const woodCount = this.countInventoryMatches(['log', 'planks']);
        if (nearbyLog && woodCount < 6) {
            const action = { type: 'collect', params: { target: 'log', count: 1 } };
            this._lastPlannedAction = action;
            console.log('[plan] collect nearby log');
            this._taskQueue.push({ ...action, retries: 0 });
            return;
        }

        // ── Pace AI decisions so the bot commits to a move instead of jittering ──
        const now = Date.now();
        if (now - this._lastDecisionMs < this._decisionCooldownMs) return;
        if (now - this._lastArrivalMs < this._arrivalCooldownMs) return;
        const pf = this.bot.pathfinder as any;
        if (pf && (pf.isMoving?.() || pf.goal)) return;

        // ── AI decides next action ──
        const action = await this.askAI();
        this._lastDecisionMs = now;
        if (action) {
            this._lastPlannedAction = { type: action.type, params: action.params };
            if (action.type !== 'wait') console.log(`[plan] ${action.type} ${JSON.stringify(action.params)}`);
            if (action.type === 'follow_player') {
                this.applyFollowTask(action.params.player, action.params.desiredDistance ?? 12, action.params.tolerance ?? 2, action.params.maxChaseDistance ?? 100);
            } else if (action.type === 'search_target') {
                this.applySearchTask(
                    action.params.target,
                    action.params.kind,
                    action.params.radius,
                    action.params.maxDistance,
                    action.params.stepDistance,
                    this.defaultFollowupActionForSearch(action.params.target, action.params.kind),
                );
            } else {
                this._taskQueue.push({ ...action, retries: 0 });
            }
        }
    }

    private buildStatePrompt(): string {
        const p = this.bot.entity?.position;
        const inv = this.bot.inventory?.items()?.filter(Boolean) ?? [];
        const invStr = inv.slice(0, 8).map(i => `${(i as any).name ?? '?'} x${i.count}`).join(', ') || 'empty';
        const hostile = p ? this.findHostile(12) : null;
        const hostileStr = hostile ? `${hostile.name} ${hostile.distance.toFixed(1)}m` : 'none';
        const hp = ((this.bot.health ?? 20).toFixed(0));
        const fd = ((this.bot.food ?? 20).toFixed(0));
        const posStr = p ? `(${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})` : '(?, ?, ?)';
        const nearbyBlocks = p ? this.findNearbyBlocks(10, 6) : [];
        const blockStr = nearbyBlocks.length > 0
            ? nearbyBlocks.map(b => `${b.name}@(${b.x}, ${b.y}, ${b.z})`).join(', ')
            : 'none';
        const nearbyPlayers = p ? this.findNearbyPlayers(24) : [];
        const playerStr = nearbyPlayers.length > 0
            ? nearbyPlayers.map(e => `${e.name}@(${e.x}, ${e.y}, ${e.z}) ${e.distance.toFixed(1)}m`).join(', ')
            : 'none';
        const nearbyEntities = p ? this.findNearbyEntities(16, 8) : [];
        const entityStr = nearbyEntities.length > 0
            ? nearbyEntities.map(e => `${e.name}@(${e.x}, ${e.y}, ${e.z}) ${e.distance.toFixed(1)}m`).join(', ')
            : 'none';
        const lastMove = this._lastMoveTarget ? `(${this._lastMoveTarget.x}, ${this._lastMoveTarget.y}, ${this._lastMoveTarget.z})` : 'none';
        return `HP: ${hp}/${fd}
Pos: ${posStr}
Inv: ${invStr}
Players nearby: ${playerStr}
Entities nearby: ${entityStr}
Hostile: ${hostileStr}
Nearby blocks: ${blockStr}
Last move target: ${lastMove}
Last event: ${this._lastEvent || 'none'}`;
    }

    private async askAI(): Promise<{ type: string; params: any } | null> {
        const state = this.buildStatePrompt();
        const p = this.bot.entity?.position;
        const hp = ((this.bot.health ?? 20).toFixed(0));
        const fd = ((this.bot.food ?? 20).toFixed(0));
        const ps = p ? `(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})` : '(?,?,?)';
        console.log(`[think] HP=${hp} FD=${fd} Pos=${ps} Q=${this._taskQueue.length} ${getProvider()}/${getModel()}`);

        const prompt = `You are EvoBot v7, a Minecraft bot. Decide the next action.

State:
${state}

Supported intents:
- move_to
- follow_player
- search_target
- collect
- craft_chain
- craft
- eat
- retreat
- wait

Respond with JSON only:
{"intent":"move_to","supported":true,"x":NUM,"y":NUM,"z":NUM}
{"intent":"follow_player","supported":true,"player":"Jacky_MC_","distance":12,"tolerance":2}
{"intent":"search_target","supported":true,"target":"sheep","kind":"entity","radius":24,"maxDistance":100,"stepDistance":12}
{"intent":"collect","supported":true,"target":"log","count":1}
{"intent":"craft_chain","supported":true,"item":"wooden_pickaxe"}
{"intent":"craft","supported":true,"item":"stone_pickaxe"}
{"intent":"eat","supported":true}
{"intent":"retreat","supported":true,"distance":16}
{"intent":"wait","supported":true}
{"intent":"refuse","supported":false,"reason":"missing_skill_or_info","fallback":"wait or collect log"}

IMPORTANT:
- If players nearby are visible and they talk to you, prefer moving toward their coordinates instead of random exploration.
- For player-following behavior, use follow_player instead of repeating move_to every cycle.
- Use search_target for unfamiliar but nearby search goals like sheep, coal, logs, or crafting tables.
- If nearby useful blocks include logs and inventory wood is low, prefer collect log before wandering.
- When idle, use move_to to explore based on nearby players, entities, and useful blocks. Do NOT pick arbitrary points when useful coordinates are available.
- Pick a destination and stick to it; do NOT ping-pong to nearby points.
- Avoid reversing direction from "Last move target".
- If hostile is nearby, use retreat.
- Coords must be integers.`;

        const reply = await callLLM([
            { role: 'system', content: 'You are a Minecraft bot AI. Respond with ONLY valid JSON, no other text. NEVER say wait when idle.' },
            { role: 'user', content: prompt },
        ], { maxTokens: 150, temperature: 0.3 });

        this._log('think.jsonl', { type: 'decision', prompt, reply });
        if (reply && reply !== '{"do":"wait"}') {
            console.log(`[think] ${reply}`);
        }

        if (!reply) {
            console.warn('[think] empty LLM reply, using deterministic fallback');
            return this.buildAutonomousFallback();
        }

        const defaultPlayer = this.findNearbyPlayers(48)[0]?.name ?? '';
        const intent = this.parseGenericIntent(reply, '(autonomous)', defaultPlayer);
        if (!intent) {
            console.warn('[think] invalid LLM JSON, using deterministic fallback');
            return this.buildAutonomousFallback();
        }

        this._lastGoalAssessment = {
            userRequest: '(autonomous)',
            intent: intent.intent,
            confidence: intent.confidence ?? 0.8,
            supported: intent.supported,
            reason: intent.reason,
            suggestedFallback: intent.fallback,
            updatedAt: Date.now(),
        };

        if (!intent.supported) {
            console.log(`[plan] refused autonomous intent: ${intent.reason ?? 'unsupported'}`);
            this._lastEvent = `REFUSED autonomous: ${intent.reason ?? 'unsupported'}`;
            return { type: 'wait', params: {} };
        }

        return this.intentToAction(intent, defaultPlayer);
    }

    /** Chat handler: LLM can both reply in text AND submit an action */
    private async handleChat(username: string, message: string): Promise<void> {
        const p = this.bot.entity?.position;
        this._log('chat.jsonl', { type: 'user', username, message, pos: p ? { x: p.x, y: p.y, z: p.z } : null });
        console.log(`[chat] <${username}> ${message}`);

        // Ignore server/system messages without a username
        if (!username || username === '§') return;

        const directIntent = this.parseDirectChatIntent(message, username);
        if (directIntent) {
            this.executeChatIntent(directIntent, message, username, '[rule]');
            return;
        }

        const state = this.buildStatePrompt();
        const memoryContext = this._plannerContext.build(message, state);
        const webContext = await this.getWebContextForPrompt(message);
        const prompt = `You are a Minecraft bot. A player is talking to you.

Your state:
${state}

Retrieved memory/context:
${memoryContext}

External knowledge:
${webContext}

Player <${username}>: "${message}"

Supported intents:
- follow_player
- search_target
- move_to
- collect
- craft
- craft_chain
- retreat
- stop
- chat_only

If the request is outside your current abilities, refuse clearly and say why.

Important command phrases:
- "come here", "here", "come", "come to me" => move_to the speaking player's current position
- "follow me" => follow_player for the speaking player
- "report", "status", "report my position" => chat_only status reply
- "collect wood", "get wood", "collect logs" => collect target=log
- "introduce yourself" => chat_only
- If you cannot extract a safe action, return chat_only instead of malformed JSON
- Never claim you executed a task until a skill actually succeeds; say "I'll try" or "starting" instead.
- If the player reports failure, use recent failures to choose a corrective action.

Respond with JSON only:
{"reply":"your chat reply","intent":"chat_only","supported":true}
{"reply":"on my way","intent":"follow_player","supported":true,"player":"Jacky_MC_","distance":12,"tolerance":2}
{"reply":"I'll search for it nearby.","intent":"search_target","supported":true,"target":"sheep","kind":"entity","radius":24,"maxDistance":100,"stepDistance":12}
{"reply":"ok coming!","intent":"move_to","supported":true,"x":0,"y":64,"z":0}
{"reply":"getting wood","intent":"collect","supported":true,"target":"log","count":1}
{"reply":"making a pickaxe","intent":"craft_chain","supported":true,"item":"wooden_pickaxe"}
{"reply":"stopping","intent":"stop","supported":true}
{"reply":"I can't build a house yet; I can gather wood or craft a table first.","intent":"refuse","supported":false,"reason":"missing_build_skill","fallback":"collect log / craft crafting_table"}`;

        const reply = await callLLM([
            { role: 'system', content: 'You are a Minecraft bot. Reply in JSON with "reply" (1 sentence) and optional action.' },
            { role: 'user', content: prompt },
        ], { maxTokens: 200, temperature: 0.7 });

        console.log(`[chat] raw LLM reply: ${reply || '(empty)'}`);
        if (!reply) {
            this.bot.chat('Hmm, I did not catch that.');
            return;
        }

        const chatIntent = this.parseGenericIntent(reply, message, username);
        if (chatIntent) {
            this.executeChatIntent(chatIntent, message, username, reply);
        } else {
            // Failed to parse JSON — treat as plain text reply
            const cleanReply = reply.slice(0, 100);
            this.bot.chat(cleanReply);
            console.log(`[chat] <EvoBot> ${cleanReply}`);
            this._log('chat.jsonl', { type: 'bot_reply', to: username, reply: cleanReply, rawLLM: reply });
        }
    }

    private async getWebContextForPrompt(message: string): Promise<string> {
        if (!/(what|how|why|can|recipe|craft|use|用途|怎么|为什么|能干什么|配方)/i.test(message)) return 'none';
        try {
            const results = await this._webKnowledge.query(message);
            if (results.length === 0) return 'none';
            return results.slice(0, 3).map((r) => `- ${r.source}: ${r.text}`).join('\n');
        } catch (e) {
            return `web query failed: ${(e as Error).message}`;
        }
    }

    private executeChatIntent(chatIntent: any, message: string, username: string, rawReply: string): void {
        this._lastGoalAssessment = {
            userRequest: message,
            intent: chatIntent.intent,
            confidence: chatIntent.confidence ?? 0.8,
            supported: chatIntent.supported,
            reason: chatIntent.reason,
            suggestedFallback: chatIntent.fallback,
            updatedAt: Date.now(),
        };
        const chatMsg = chatIntent.reply || '';
        if (chatMsg && chatMsg !== 'wait') {
            this.bot.chat(chatMsg);
            console.log(`[chat] <EvoBot> ${chatMsg}`);
            this._log('chat.jsonl', { type: 'bot_reply', to: username, reply: chatMsg, rawLLM: rawReply });
        } else {
            console.log('[chat] no reply text in JSON');
        }
        if (!chatIntent.supported) {
            console.log(`[chat] refused: ${chatIntent.reason ?? 'unsupported'}`);
            return;
        }
        if (this.applyPlannerTemplate(chatIntent, message, username)) return;
        const action = this.intentToAction(chatIntent, username);
        if (!action || action.type === 'wait') return;
        if (action.type === 'follow_player') {
            this.applyFollowTask(action.params.player || username, action.params.desiredDistance ?? 12, action.params.tolerance ?? 2, action.params.maxChaseDistance ?? 100);
            this._taskQueue = [];
            console.log(`[chat] set runtime task: follow_player ${JSON.stringify(action.params)}`);
        } else if (action.type === 'search_target') {
                this.applySearchTask(
                    action.params.target,
                    action.params.kind,
                    action.params.radius,
                    action.params.maxDistance,
                    action.params.stepDistance,
                    this.defaultFollowupActionForSearch(action.params.target, action.params.kind),
                );
            this._taskQueue = [];
            console.log(`[chat] set runtime task: search_target ${JSON.stringify(action.params)}`);
        } else if (action.type === 'stop') {
            this.clearRuntimeTask();
            this._taskQueue = [];
            console.log('[chat] stopped current work');
        } else {
            this._taskQueue = [{ ...action, retries: 0 }];
            console.log(`[chat] enqueued: ${action.type} ${JSON.stringify(action.params)}`);
        }
    }

    private applyPlannerTemplate(chatIntent: any, message: string, username: string): boolean {
        const compact = String(message || '').toLowerCase().replace(/[!?.,]/g, ' ').replace(/\s+/g, ' ').trim();
        const inventory = this.getInventoryCounts();

        if (chatIntent.intent === 'craft_chain' && ['crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'furnace'].includes(chatIntent.item)) {
            const plan = buildSubgoalPlan(chatIntent.item, inventory);
            if (plan) {
                this._taskQueue = plan.map((step) => ({ ...step, retries: 0 }));
                console.log(`[planner] using subgoal plan for ${chatIntent.item}`);
            } else {
                this._taskQueue = [{ type: 'craft_chain', params: { item: chatIntent.item }, retries: 0 }];
                console.log(`[planner] using craft_chain template for ${chatIntent.item}`);
            }
            return true;
        }

        if (chatIntent.intent === 'collect' && chatIntent.target === 'log') {
            this._taskQueue = [{ type: 'collect', params: { target: 'log', count: chatIntent.count ?? 1, maxDistance: 24 }, retries: 0 }];
            console.log('[planner] using collect-log template');
            return true;
        }

        if (/(mine coal|get coal|collect coal ore)/.test(compact)) {
            this._taskQueue = [{ type: 'collect', params: { target: 'coal_ore', count: 1, maxDistance: 24 }, retries: 0 }];
            console.log('[planner] using mine-coal template');
            return true;
        }

        if (/(mine cobblestone|get cobblestone|collect stone)/.test(compact)) {
            this._taskQueue = [{ type: 'collect', params: { target: 'stone', count: 3, maxDistance: 24 }, retries: 0 }];
            console.log('[planner] using mine-stone template');
            return true;
        }

        if (/(kill sheep|collect wool|get mutton)/.test(compact)) {
            this.applySearchTask('sheep', 'entity', 24, 100, 12, { type: 'attack_entity', params: { target: 'sheep', count: 1 } });
            this._taskQueue = [];
            console.log('[planner] using sheep-search template');
            return true;
        }

        if (/(didnt work|didn't work|not working|failed|失败|没用)/.test(compact) && this._currentTask) {
            const task = this._currentTask;
            if (task.type === 'collect' && task.params?.target === 'log') {
                this._taskQueue = [{ type: 'collect', params: { target: 'log', count: 1, maxDistance: 24 }, retries: 0 }];
                console.log('[planner] retrying collect-log with wider search radius');
                return true;
            }
        }

        if (chatIntent.intent === 'chat_only' && /(craft wooden pickaxe|make wooden pickaxe|木镐)/.test(compact)) {
            this._taskQueue = (buildSubgoalPlan('wooden_pickaxe', inventory) ?? [{ type: 'craft_chain', params: { item: 'wooden_pickaxe' } }]).map((step) => ({ ...step, retries: 0 }));
            console.log('[planner] promoted chat request to wooden_pickaxe subgoal plan');
            return true;
        }

        if (chatIntent.intent === 'chat_only' && /(craft stone pickaxe|make stone pickaxe|石镐)/.test(compact)) {
            this._taskQueue = (buildSubgoalPlan('stone_pickaxe', inventory) ?? [{ type: 'craft_chain', params: { item: 'stone_pickaxe' } }]).map((step) => ({ ...step, retries: 0 }));
            console.log('[planner] promoted chat request to stone_pickaxe subgoal plan');
            return true;
        }

        if (chatIntent.intent === 'chat_only' && /(craft furnace|make furnace|熔炉)/.test(compact)) {
            this._taskQueue = (buildSubgoalPlan('furnace', inventory) ?? [{ type: 'craft_chain', params: { item: 'furnace' } }]).map((step) => ({ ...step, retries: 0 }));
            console.log('[planner] promoted chat request to furnace subgoal plan');
            return true;
        }

        return false;
    }

    private planFailureRecovery(username: string): any | null {
        const failure = this._lastFailure;
        if (!failure) return null;

        if (failure.taskType === 'collect' && failure.params?.target === 'log') {
            return {
                intent: 'search_target',
                supported: true,
                confidence: 0.95,
                reply: 'last wood collection failed; I will search for a reachable log first',
                target: 'log',
                kind: 'block',
                radius: 24,
                maxDistance: 100,
                stepDistance: 12,
            };
        }

        if (failure.taskType === 'collect' && String(failure.params?.target || '').includes('stone')) {
            return {
                intent: 'search_target',
                supported: true,
                confidence: 0.95,
                reply: 'stone collection failed; I will search for a closer reachable stone block',
                target: 'stone',
                kind: 'block',
                radius: 24,
                maxDistance: 100,
                stepDistance: 12,
            };
        }

        if (failure.taskType === 'collect' && String(failure.params?.target || '').includes('coal')) {
            return {
                intent: 'search_target',
                supported: true,
                confidence: 0.95,
                reply: 'coal mining failed; I will search for a reachable coal ore vein first',
                target: 'coal_ore',
                kind: 'block',
                radius: 24,
                maxDistance: 100,
                stepDistance: 12,
            };
        }

        if (failure.taskType === 'craft_chain' && failure.params?.item === 'wooden_pickaxe') {
            return {
                intent: 'collect',
                supported: true,
                confidence: 0.9,
                reply: 'crafting the wooden pickaxe failed; I will gather more logs first',
                target: 'log',
                count: 2,
            };
        }

        if (failure.taskType === 'craft_chain' && failure.params?.item === 'stone_pickaxe') {
            return {
                intent: 'collect',
                supported: true,
                confidence: 0.9,
                reply: 'crafting the stone pickaxe failed; I will collect more stone first',
                target: 'stone',
                count: 3,
            };
        }

        if (failure.taskType === 'move_to') {
            const playerPos = (this.bot.players[username] as any)?.entity?.position;
            if (playerPos) {
                return {
                    intent: 'follow_player',
                    supported: true,
                    confidence: 0.9,
                    reply: 'moving directly failed; I will follow you instead',
                    player: username,
                    distance: 4,
                    tolerance: 2,
                };
            }
        }

        return {
            intent: 'chat_only',
            supported: true,
            confidence: 0.8,
            reply: `The last task failed: ${failure.taskType} (${failure.failureType ?? 'unknown'}). Give me a smaller step or let me retry differently.`,
        };
    }

    private defaultFollowupActionForSearch(target: string, kind: 'entity' | 'block'): { type: string; params: any } | null {
        const normalized = String(target || '').toLowerCase();
        if (kind === 'entity') {
            if (normalized.includes('sheep')) return { type: 'attack_entity', params: { target: 'sheep', count: 1 } };
            if (normalized.includes('pig')) return { type: 'attack_entity', params: { target: 'pig', count: 1 } };
        }
        if (kind === 'block') {
            if (normalized.includes('log')) return { type: 'collect', params: { target: 'log', count: 1, maxDistance: 24 } };
            if (normalized.includes('coal')) return { type: 'collect', params: { target: 'coal_ore', count: 1, maxDistance: 24 } };
            if (normalized.includes('stone') || normalized.includes('cobblestone')) return { type: 'collect', params: { target: 'stone', count: 3, maxDistance: 24 } };
        }
        return null;
    }

    private parseDirectChatIntent(message: string, username: string): any | null {
        const normalized = message.trim().toLowerCase();
        const compact = normalized.replace(/[!?.,]/g, ' ').replace(/\s+/g, ' ').trim();
        const playerPos = (this.bot.players[username] as any)?.entity?.position;
        if (/(^|\s)(follow me|follow)(\s|$)/.test(compact)) {
            return { intent: 'follow_player', supported: true, reply: 'on my way', player: username, distance: 12, tolerance: 2, confidence: 0.95 };
        }
        if (/(^|\s)(come here|come to me|come|here)(\s|$)/.test(compact) && playerPos) {
            return {
                intent: 'move_to', supported: true, reply: 'coming!', confidence: 0.95,
                x: Math.round(playerPos.x), y: Math.round(playerPos.y), z: Math.round(playerPos.z),
            };
        }
        if (/(report my position|where am i)/.test(compact) && playerPos) {
            return {
                intent: 'chat_only', supported: true, confidence: 0.95,
                reply: `You're at (${Math.round(playerPos.x)}, ${Math.round(playerPos.y)}, ${Math.round(playerPos.z)}).`,
            };
        }
        if (/(^|\s)(report|status)(\s|$)/.test(compact)) {
            return { intent: 'chat_only', supported: true, confidence: 0.95, reply: this.getStatusSummary().replace(/\n+/g, ' ').slice(0, 180) };
        }
        if (/(scan|look around|what do you see|附近有什么)/.test(compact)) {
            return { intent: 'chat_only', supported: true, confidence: 0.95, reply: this.getScanSummary('', 16).replace(/\n+/g, ' ').slice(0, 220) };
        }
        if (/(collect|get|gather).*(wood|log)|woods/.test(compact)) {
            return { intent: 'collect', supported: true, confidence: 0.9, reply: 'getting wood', target: 'log', count: 1 };
        }
        if (/(use|equip).*(axe)|axe/.test(compact)) {
            const hasAxe = this.bot.inventory.items().some((item: any) => item.name.includes('axe'));
            return {
                intent: 'chat_only', supported: true, confidence: 0.9,
                reply: hasAxe ? 'I will use an axe when chopping logs.' : 'I do not have an axe right now, but I can still punch logs or craft one if we have materials.',
            };
        }
        if (/(didnt work|didn't work|not working|failed|失败|没用)/.test(compact)) {
            if (this._lastFailure) {
                const corrective = this.planFailureRecovery(username);
                if (corrective) return corrective;
            }
            const memory = this._plannerContext.build(compact, this.buildStatePrompt()).replace(/\n+/g, ' ').slice(0, 160);
            return { intent: 'chat_only', supported: true, confidence: 0.85, reply: `I see it failed. I'll use the recent failure context and try a smaller corrective step. ${memory}`.slice(0, 240) };
        }
        if (/(crafting table|workbench|工作台)/.test(compact)) {
            const hasTable = this.bot.inventory.items().some((item: any) => item.name === 'crafting_table');
            return hasTable
                ? { intent: 'chat_only', supported: true, confidence: 0.9, reply: 'Yes, I have a crafting table.' }
                : { intent: 'craft_chain', supported: true, confidence: 0.85, reply: 'I do not have one; I will try to make a crafting table.', item: 'crafting_table' };
        }
        if (/(introduce yourself|who are you)/.test(compact)) {
            return { intent: 'chat_only', supported: true, confidence: 0.95, reply: "I'm EvoBot, a Minecraft helper bot that can follow you, collect resources, search nearby targets, and craft basic tools." };
        }
        const forwardMatch = compact.match(/move forward(?:\s+(\d+))?/);
        if (forwardMatch) {
            const distance = Number(forwardMatch[1] || 3);
            const yaw = this.bot.entity.yaw;
            return {
                intent: 'move_to', supported: true, confidence: 0.85, reply: `moving forward ${distance} blocks`,
                x: Math.round(this.bot.entity.position.x - Math.sin(yaw) * distance),
                y: Math.round(this.bot.entity.position.y),
                z: Math.round(this.bot.entity.position.z - Math.cos(yaw) * distance),
            };
        }
        return null;
    }

    /** Parse JSON action from LLM response */
    private parseAction(raw: string): { type: string; params: any; _reply?: string } | null {
        const m = this.extractJsonObject(raw);
        if (!m) return null;
        try {
            const j = JSON.parse(m);
            const r: any = { type: 'wait', params: {}, _reply: j.reply };
            if (j.do === 'move_to') { r.type = 'move_to'; r.params = { x: j.x, y: j.y, z: j.z, reachDistance: 2 }; }
            else if (j.do === 'follow_player') { r.type = 'follow_player'; r.params = { player: j.player, desiredDistance: j.distance ?? 12, tolerance: j.tolerance ?? 2, maxChaseDistance: j.maxDistance ?? 100 }; }
            else if (j.do === 'collect') { r.type = 'collect'; r.params = { target: j.target, count: j.count ?? 1 }; }
            else if (j.do === 'craft_chain') { r.type = 'craft_chain'; r.params = { item: j.item }; }
            else if (j.do === 'craft') { r.type = 'craft'; r.params = { item: j.item, count: 1 }; }
            else if (j.do === 'retreat') { r.type = 'retreat'; r.params = { distance: j.distance ?? 16 }; }
            else if (j.do === 'stop') { r.type = 'stop'; r.params = {}; }
            return r;
        } catch { return null; }
    }

    private parseGenericIntent(raw: string, message: string, defaultPlayer: string): any | null {
        const m = this.extractJsonObject(raw);
        if (!m) return null;
        try {
            const j = JSON.parse(m);
            return {
                intent: j.intent ?? 'chat_only',
                supported: j.supported !== false,
                reason: j.reason,
                fallback: j.fallback,
                reply: j.reply ?? '',
                confidence: typeof j.confidence === 'number' ? j.confidence : 0.8,
                player: j.player ?? defaultPlayer,
                distance: j.distance,
                tolerance: j.tolerance,
                maxDistance: j.maxDistance,
                kind: j.kind,
                radius: j.radius,
                stepDistance: j.stepDistance,
                x: j.x,
                y: j.y,
                z: j.z,
                target: j.target,
                count: j.count,
                item: j.item,
                originalMessage: message,
            };
        } catch {
            return null;
        }
    }

    private extractJsonObject(raw: string): string | null {
        const clean = raw.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
        const m = clean.match(/\{[\s\S]*\}/);
        if (!m) return null;
        const candidate = m[0].trim();
        try {
            JSON.parse(candidate);
            return candidate;
        } catch {}

        let repaired = candidate
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/,(\s*[}\]])/g, '$1')
            .replace(/"(-?\d+(?:\.\d+)?)"(?=\s*[},])/g, '$1')
            .replace(/:\s*"(true|false|null)"(?=\s*[},])/gi, ': $1');

        const quoteCount = (repaired.match(/"/g) || []).length;
        if (quoteCount % 2 === 1) repaired += '"';

        const openBraces = (repaired.match(/\{/g) || []).length;
        const closeBraces = (repaired.match(/\}/g) || []).length;
        if (closeBraces < openBraces) repaired += '}'.repeat(openBraces - closeBraces);

        try {
            JSON.parse(repaired);
            console.warn('[json] repaired malformed LLM JSON');
            return repaired;
        } catch {
            return null;
        }
    }

    private buildAutonomousFallback(): { type: string; params: any } {
        const nearestPlayer = this.findNearbyPlayers(24)[0];
        if (nearestPlayer) {
            return {
                type: 'move_to',
                params: { x: Math.round(nearestPlayer.x), y: Math.round(nearestPlayer.y), z: Math.round(nearestPlayer.z), reachDistance: 2 },
            };
        }
        const usefulBlock = this.bot.findBlock({
            matching: (b: any) => ['log', 'coal_ore', 'crafting_table'].some((name) => b?.name?.includes(name)),
            maxDistance: 12,
        });
        if (usefulBlock) {
            return {
                type: 'move_to',
                params: { x: Math.round(usefulBlock.position.x), y: Math.round(usefulBlock.position.y), z: Math.round(usefulBlock.position.z), reachDistance: 2 },
            };
        }
        const p = this.bot.entity?.position;
        if (p) {
            return { type: 'move_to', params: { x: Math.round(p.x + 4), y: Math.round(p.y), z: Math.round(p.z), reachDistance: 2 } };
        }
        return { type: 'wait', params: {} };
    }

    private intentToAction(intent: any, username: string): { type: string; params: any } | null {
        switch (intent.intent) {
            case 'follow_player':
                return { type: 'follow_player', params: { player: intent.player || username, desiredDistance: intent.distance ?? 12, tolerance: intent.tolerance ?? 2, maxChaseDistance: intent.maxDistance ?? 100 } };
            case 'search_target':
                return { type: 'search_target', params: { target: intent.target, kind: intent.kind === 'block' ? 'block' : 'entity', radius: intent.radius ?? 24, maxDistance: intent.maxDistance ?? 100, stepDistance: intent.stepDistance ?? 12 } };
            case 'move_to':
                return { type: 'move_to', params: { x: intent.x, y: intent.y, z: intent.z, reachDistance: 2 } };
            case 'collect':
                return { type: 'collect', params: { target: intent.target, count: intent.count ?? 1 } };
            case 'craft_chain':
                return { type: 'craft_chain', params: { item: intent.item } };
            case 'craft':
                return { type: 'craft', params: { item: intent.item, count: 1 } };
            case 'eat':
                return { type: 'eat', params: {} };
            case 'retreat':
                return { type: 'retreat', params: { distance: intent.distance ?? 16 } };
            case 'wait':
                return { type: 'wait', params: {} };
            case 'stop':
                return { type: 'stop', params: {} };
            default:
                return null;
        }
    }

    private async runSkill(type: string, params: any): Promise<SkillResult> {
        if (type === 'wait') return { ok: true, detail: 'Waited one tick' };
        if (type === 'stop') {
            this.clearRuntimeTask();
            this._taskQueue = [];
            return { ok: true, detail: 'Stopped current work' };
        }
        if (type === 'attack_entity') {
            const beforeState = this.buildStatePrompt();
            const beforeSnapshot = captureTaskSnapshot(this.bot);
            const result = await this.attackNamedEntity(params);
            const afterSnapshot = captureTaskSnapshot(this.bot);
            const verification = verifyTask(type, params, beforeSnapshot, afterSnapshot);
            this._failureMemory.record(type, params, result, beforeState);
            this._log('task-results.jsonl', {
                type,
                params,
                ok: result.ok,
                detail: result.detail,
                failureType: result.failureType,
                verification,
                beforeState,
                afterState: this.buildStatePrompt(),
            });
            return result;
        }
        const s = this.skills.get(type);
        if (!s) return { ok: false, detail: `Unknown skill: ${type}` };
        const beforeState = this.buildStatePrompt();
        const beforeSnapshot = captureTaskSnapshot(this.bot);
        const result = await s.run(params);
        const afterSnapshot = captureTaskSnapshot(this.bot);
        const verification = verifyTask(type, params, beforeSnapshot, afterSnapshot);
        this._failureMemory.record(type, params, result, beforeState);
        this._log('task-results.jsonl', {
            type,
            params,
            ok: result.ok,
            detail: result.detail,
            failureType: result.failureType,
            verification,
            beforeState,
            afterState: this.buildStatePrompt(),
        });
        return result;
    }

    private async attackNamedEntity(params: { target: string; count?: number }): Promise<SkillResult> {
        const targetName = String(params?.target || '').toLowerCase();
        const desiredCount = Math.max(1, Number(params?.count || 1));
        const beforeDrops = this.countInventoryMatches(['wool', 'mutton', targetName]);
        let defeats = 0;

        for (let i = 0; i < desiredCount; i++) {
            const entity = this.findNearestMatchingEntityObject(targetName, 20);
            if (!entity) {
                return defeats > 0
                    ? { ok: true, detail: `Attacked ${defeats}/${desiredCount} ${targetName}` }
                    : { ok: false, detail: `No ${targetName} nearby to attack`, failureType: 'target_lost' };
            }

            try { this.bot.pathfinder?.setGoal(new (require('mineflayer-pathfinder').goals.GoalNear)(entity.position.x, entity.position.y, entity.position.z, 2), true); } catch {}
            const start = Date.now();
            while (Date.now() - start < 8000) {
                const live = this.findNearestMatchingEntityObject(targetName, 6);
                if (!live) break;
                try { await this.bot.lookAt(live.position.offset(0, 1, 0), true); } catch {}
                try { this.bot.attack(live as any); } catch {}
                await this.sleep(450);
            }
            defeats++;
        }

        const afterDrops = this.countInventoryMatches(['wool', 'mutton', targetName]);
        if (afterDrops <= beforeDrops && defeats === 0) {
            return { ok: false, detail: `Tried attacking ${targetName}, but got no result`, failureType: 'target_lost' };
        }
        return { ok: true, detail: `Attacked ${targetName}; inventory delta=${afterDrops - beforeDrops}` };
    }

    private async tickRuntimeTask(): Promise<boolean> {
        const task = this._runtimeTask;
        if (!task) return false;
        if (task.status === 'paused' || task.status === 'failed') return true;
        if (task.status === 'interrupted') return true;
        if (task.type === 'follow_player') {
            return this.tickFollowPlayerTask(task);
        }
        if (task.type === 'search_target') {
            return this.tickSearchTargetTask(task);
        }
        return false;
    }

    private async tickFollowPlayerTask(task: Extract<RuntimeTask, { type: 'follow_player' }>): Promise<boolean> {
        const target = this.findPlayerEntity(task.targetPlayer);
        if (!target) {
            task.status = 'interrupted';
            task.interruptReason = 'target_lost';
            task.lastError = `Player not visible: ${task.targetPlayer}`;
            this._lastEvent = `INTERRUPTED follow_player: ${task.lastError}`;
            try { this.bot.pathfinder?.stop(); } catch {}
            return true;
        }

        const distance = this.bot.entity.position.distanceTo(target.position);
        task.lastKnownTargetPos = { x: target.position.x, y: target.position.y, z: target.position.z };
        task.updatedAt = Date.now();

        if (distance > task.maxChaseDistance) {
            task.status = 'interrupted';
            task.interruptReason = 'target_too_far';
            task.lastError = `Target beyond max chase distance: ${distance.toFixed(1)}m`;
            this._lastEvent = `INTERRUPTED follow_player: ${task.lastError}`;
            try { this.bot.pathfinder?.stop(); } catch {}
            return true;
        }

        const error = distance - task.desiredDistance;
        const withinBand = Math.abs(error) <= task.tolerance;
        if (withinBand) {
            try { this.bot.pathfinder?.stop(); } catch {}
            try { await this.bot.lookAt(target.position.offset(0, 1, 0), true); } catch {}
            this._lastEvent = `FOLLOW holding ${target.username ?? target.name} err=${error.toFixed(1)}m`;
            return true;
        }

        if (error < -task.tolerance) {
            try { this.bot.pathfinder?.stop(); } catch {}
            try { await this.bot.lookAt(target.position.offset(0, 1, 0), true); } catch {}
            this._lastEvent = `FOLLOW too close to ${target.username ?? target.name} err=${error.toFixed(1)}m`;
            return true;
        }

        if (!this.isLikelyReachable(target.position, task.maxChaseDistance)) {
            task.status = 'interrupted';
            task.interruptReason = 'unreachable';
            task.lastError = 'Target seems unreachable from current terrain';
            this._lastEvent = `INTERRUPTED follow_player: ${task.lastError}`;
            try { this.bot.pathfinder?.stop(); } catch {}
            return true;
        }

        const shouldRefreshGoal = !this._lastFollowTargetSnapshot
            || Date.now() - this._lastFollowGoalUpdateMs > 1000
            || Math.sqrt(
                Math.pow(target.position.x - this._lastFollowTargetSnapshot.x, 2)
                + Math.pow(target.position.y - this._lastFollowTargetSnapshot.y, 2)
                + Math.pow(target.position.z - this._lastFollowTargetSnapshot.z, 2)
            ) > Math.max(2, task.tolerance);

        if (shouldRefreshGoal) {
            const GN = getGoalNear();
            if (!GN) return true;
            this.bot.pathfinder.setGoal(new GN(target.position.x, target.position.y, target.position.z, task.desiredDistance), true);
            this._lastFollowGoalUpdateMs = Date.now();
            this._lastFollowTargetSnapshot = { x: target.position.x, y: target.position.y, z: target.position.z };
            this._lastMoveTarget = { x: Math.round(target.position.x), y: Math.round(target.position.y), z: Math.round(target.position.z) };
            console.log(`[plan] follow_player ${task.targetPlayer} dist=${task.desiredDistance} err=${error.toFixed(1)}m`);
        }

        this._lastEvent = `FOLLOW chasing ${task.targetPlayer} err=${error.toFixed(1)}m`;
        return true;
    }

    private async tickSearchTargetTask(task: Extract<RuntimeTask, { type: 'search_target' }>): Promise<boolean> {
        const found = task.targetKind === 'entity'
            ? this.findMatchingEntity(task.targetName, task.searchRadius)
            : this.findMatchingBlock(task.targetName, task.searchRadius);

        if (found) {
            task.lastKnownTargetPos = { x: found.x, y: found.y, z: found.z };
            task.updatedAt = Date.now();
            this._lastEvent = `SEARCH found ${task.targetName} @ (${found.x}, ${found.y}, ${found.z})`;
            if (task.onFoundAction && this.bot.entity.position.distanceTo(found as any) <= (task.targetKind === 'entity' ? 4 : 3.5)) {
                const action = task.onFoundAction;
                this.clearRuntimeTask();
                this._taskQueue = [{ ...action, retries: 0 }];
                console.log(`[planner] search_target found ${task.targetName}; chaining ${action.type} ${JSON.stringify(action.params)}`);
                this._lastEvent = `SEARCH chained ${action.type} after finding ${task.targetName}`;
                return true;
            }
            if (this.isLikelyReachable(found, task.maxSearchDistance)) {
                const GN = getGoalNear();
                if (GN && (Date.now() - this._lastSearchGoalUpdateMs > 1000 || !this._lastMoveTarget || this.distanceSq(this._lastMoveTarget, found) > 4)) {
                    this.bot.pathfinder.setGoal(new GN(found.x, found.y, found.z, task.targetKind === 'entity' ? 3 : 2), true);
                    this._lastSearchGoalUpdateMs = Date.now();
                    this._lastMoveTarget = { x: Math.round(found.x), y: Math.round(found.y), z: Math.round(found.z) };
                    console.log(`[plan] search_target goto ${task.targetName} @ (${Math.round(found.x)}, ${Math.round(found.y)}, ${Math.round(found.z)})`);
                }
                return true;
            }
        }

        const nextExplore = this.pickSearchExplorePoint(task);
        if (!nextExplore) {
            task.status = 'failed';
            task.lastError = `Could not find or reach ${task.targetName} within ${task.maxSearchDistance} blocks`;
            this._lastEvent = `FAILED search_target: ${task.lastError}`;
            this._lastGoalAssessment = {
                userRequest: task.targetName,
                intent: 'search_target',
                confidence: 0.9,
                supported: false,
                reason: 'search_exhausted',
                suggestedFallback: `scan nearby again or choose a closer target than ${task.targetName}`,
                updatedAt: Date.now(),
            };
            try { this.bot.pathfinder?.stop(); } catch {}
            return true;
        }

        const GN = getGoalNear();
        if (!GN) return true;
        if (Date.now() - this._lastSearchGoalUpdateMs > 1500 || !this._lastMoveTarget || this.distanceSq(this._lastMoveTarget, nextExplore) > 9) {
            this.bot.pathfinder.setGoal(new GN(nextExplore.x, nextExplore.y, nextExplore.z, 2), true);
            this._lastSearchGoalUpdateMs = Date.now();
            this._lastMoveTarget = { x: nextExplore.x, y: nextExplore.y, z: nextExplore.z };
            task.exploredSteps++;
            console.log(`[plan] search_target explore ${task.targetName} -> (${nextExplore.x}, ${nextExplore.y}, ${nextExplore.z})`);
        }
        task.updatedAt = Date.now();
        this._lastEvent = `SEARCH exploring for ${task.targetName} step=${task.exploredSteps}`;
        return true;
    }

    private isRetryableFailure(result: SkillResult): boolean {
        return result.failureType === 'cancelled' || result.failureType === 'path_stuck' || result.failureType === 'timeout';
    }

    private applyFollowTask(player: string, desiredDistance: number, tolerance: number, maxChaseDistance: number): void {
        const targetPlayer = player || this.findNearbyPlayers(48)[0]?.name || '';
        if (!targetPlayer) {
            console.warn('[V7] Cannot start follow_player: no target player resolved');
            return;
        }
        this._runtimeTask = {
            id: `follow_${Date.now()}`,
            type: 'follow_player',
            status: 'running',
            targetPlayer,
            desiredDistance: Math.max(1, Math.min(desiredDistance, 100)),
            tolerance: Math.max(0.5, Math.min(tolerance, 10)),
            maxChaseDistance: Math.max(5, Math.min(maxChaseDistance, 100)),
            resumeAfterInterrupt: true,
            retries: 0,
            updatedAt: Date.now(),
        };
        this._lastFollowGoalUpdateMs = 0;
        this._lastFollowTargetSnapshot = null;
        this._lastEvent = `TASK follow_player -> ${targetPlayer}`;
    }

    private applySearchTask(targetName: string, targetKind: 'entity' | 'block', searchRadius: number, maxSearchDistance: number, exploreStepDistance: number, onFoundAction: { type: string; params: any } | null): void {
        const pos = this.bot.entity?.position;
        if (!pos) return;
        this._runtimeTask = {
            id: `search_${Date.now()}`,
            type: 'search_target',
            status: 'running',
            targetName,
            targetKind,
            searchRadius: Math.max(8, Math.min(searchRadius, 64)),
            maxSearchDistance: Math.max(8, Math.min(maxSearchDistance, 100)),
            exploreStepDistance: Math.max(4, Math.min(exploreStepDistance, 24)),
            exploredSteps: 0,
            anchorPos: { x: pos.x, y: pos.y, z: pos.z },
            resumeAfterInterrupt: true,
            onFoundAction,
            retries: 0,
            updatedAt: Date.now(),
        };
        this._lastSearchGoalUpdateMs = 0;
        this._lastEvent = `TASK search_target -> ${targetName}`;
    }

    private interruptRuntimeTask(reason: string): void {
        if (!this._runtimeTask || this._runtimeTask.status !== 'running') return;
        if (!this._runtimeTask.resumeAfterInterrupt) return;
        this._runtimeTask.status = 'interrupted';
        this._runtimeTask.interruptReason = reason;
        this._runtimeTask.updatedAt = Date.now();
    }

    private resumeRuntimeTaskIfPossible(reason: string): void {
        if (!this._runtimeTask || this._runtimeTask.status !== 'interrupted') return;
        if (this._runtimeTask.interruptReason !== reason) return;
        this._runtimeTask.status = 'running';
        this._runtimeTask.interruptReason = undefined;
        this._runtimeTask.updatedAt = Date.now();
        this._lastFollowGoalUpdateMs = 0;
    }

    private findPlayerEntity(name: string): any {
        const wanted = (name ?? '').trim().toLowerCase();
        if (!wanted) return null;
        for (const [, e] of Object.entries(this.bot.entities)) {
            if (!e || (e as any).type !== 'player') continue;
            const username = (((e as any).username ?? (e as any).name ?? '') as string).trim().toLowerCase();
            if (username === wanted) return e;
        }
        return null;
    }

    private findMatchingEntity(name: string, radius: number): { x: number; y: number; z: number; name: string } | null {
        const pos = this.bot.entity?.position;
        if (!pos) return null;
        const wanted = name.toLowerCase();
        let best: { x: number; y: number; z: number; name: string } | null = null;
        let bestDist = Infinity;
        for (const [, e] of Object.entries(this.bot.entities)) {
            if (!e || (e as any).type === 'player') continue;
            const ename = (((e as any).name ?? (e as any).displayName ?? '') as string).toLowerCase();
            if (!ename.includes(wanted)) continue;
            const d = pos.distanceTo(e.position);
            if (d > radius || d >= bestDist) continue;
            bestDist = d;
            best = { x: e.position.x, y: e.position.y, z: e.position.z, name: (e as any).name ?? wanted };
        }
        return best;
    }

    private findNearestMatchingEntityObject(name: string, radius: number): any | null {
        const pos = this.bot.entity?.position;
        if (!pos) return null;
        const wanted = name.toLowerCase();
        let best: any = null;
        let bestDist = Infinity;
        for (const [, e] of Object.entries(this.bot.entities)) {
            if (!e || (e as any).type === 'player') continue;
            const ename = (((e as any).name ?? (e as any).displayName ?? '') as string).toLowerCase();
            if (!ename.includes(wanted)) continue;
            const d = pos.distanceTo(e.position);
            if (d > radius || d >= bestDist) continue;
            bestDist = d;
            best = e;
        }
        return best;
    }

    private findMatchingBlock(name: string, radius: number): { x: number; y: number; z: number; name: string } | null {
        const block = this.bot.findBlock({ matching: (b: any) => b?.name?.includes(name) ?? false, maxDistance: radius });
        if (!block) return null;
        return { x: block.position.x, y: block.position.y, z: block.position.z, name: block.name };
    }

    private pickSearchExplorePoint(task: Extract<RuntimeTask, { type: 'search_target' }>): { x: number; y: number; z: number } | null {
        const pos = this.bot.entity?.position;
        if (!pos) return null;
        const base = task.anchorPos;
        const step = task.exploreStepDistance;
        const ring = Math.floor(task.exploredSteps / 8) + 1;
        const angleIndex = task.exploredSteps % 8;
        const angle = (Math.PI * 2 * angleIndex) / 8;
        const x = Math.round(base.x + Math.cos(angle) * step * ring);
        const z = Math.round(base.z + Math.sin(angle) * step * ring);
        const y = Math.round(pos.y);
        const candidate = { x, y, z };
        if (!this.isLikelyReachable(candidate, task.maxSearchDistance)) return null;
        return candidate;
    }

    private distanceSq(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
        return Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2);
    }

    private isLikelyReachable(targetPos: { x: number; y: number; z: number }, maxDistance: number): boolean {
        const pos = this.bot.entity?.position;
        if (!pos) return false;
        const dx = targetPos.x - pos.x;
        const dy = targetPos.y - pos.y;
        const dz = targetPos.z - pos.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) > maxDistance) return false;
        if (Math.abs(targetPos.y - pos.y) > 12) return false;
        const samples = 8;
        for (let i = 1; i <= samples; i++) {
            const t = i / samples;
            const x = Math.round(pos.x + (targetPos.x - pos.x) * t);
            const y = Math.round(pos.y + (targetPos.y - pos.y) * t);
            const z = Math.round(pos.z + (targetPos.z - pos.z) * t);
            const block = this.bot.blockAt(this.bot.entity.position.floored().offset(x - Math.floor(pos.x), y - Math.floor(pos.y), z - Math.floor(pos.z)));
            const name = block?.name ?? '';
            if (name.includes('lava')) return false;
            if (name.includes('water') && i >= Math.ceil(samples / 2)) return false;
        }
        return true;
    }

    private findHostile(radius: number): any {
        const pos = this.bot.entity?.position;
        if (!pos) return null;
        let best: any = null;
        let min = Infinity;
        for (const [, e] of Object.entries(this.bot.entities)) {
            if (!e) continue;
            const name = ((e as any).name ?? '').toLowerCase();
            if (['zombie','skeleton','spider','creeper','enderman'].some(h => name.includes(h))) {
                const d = pos.distanceTo(e.position);
                if (d < min && d <= radius) { min = d; best = { name: (e as any).name ?? '?', distance: d, position: e.position }; }
            }
        }
        return best;
    }

    private countInventoryMatches(parts: string[]): number {
        return (this.bot.inventory?.items?.() ?? []).reduce((sum, item) => {
            const name = ((item as any).name ?? '').toString();
            return sum + (parts.some(part => name.includes(part)) ? item.count : 0);
        }, 0);
    }

    private getInventoryCounts(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const item of this.bot.inventory?.items?.() ?? []) {
            const name = ((item as any).name ?? '').toString();
            out[name] = (out[name] ?? 0) + item.count;
        }
        return out;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private findNearbyPlayers(radius: number): Array<{ name: string; x: number; y: number; z: number; distance: number }> {
        const pos = this.bot.entity?.position;
        if (!pos) return [];
        const out: Array<{ name: string; x: number; y: number; z: number; distance: number }> = [];
        for (const [, e] of Object.entries(this.bot.entities)) {
            if (!e || (e as any).type !== 'player') continue;
            const name = ((e as any).username ?? (e as any).name ?? '').trim();
            if (!name || name === this.bot.username) continue;
            const d = pos.distanceTo(e.position);
            if (d > radius) continue;
            out.push({
                name,
                x: e.position.x.toFixed ? Number(e.position.x.toFixed(0)) : Math.round(e.position.x),
                y: e.position.y.toFixed ? Number(e.position.y.toFixed(0)) : Math.round(e.position.y),
                z: e.position.z.toFixed ? Number(e.position.z.toFixed(0)) : Math.round(e.position.z),
                distance: d,
            });
        }
        out.sort((a, b) => a.distance - b.distance);
        return out.slice(0, 6);
    }

    private findNearbyEntities(radius: number, limit: number): Array<{ name: string; x: number; y: number; z: number; distance: number }> {
        const pos = this.bot.entity?.position;
        if (!pos) return [];
        const out: Array<{ name: string; x: number; y: number; z: number; distance: number }> = [];
        for (const [, e] of Object.entries(this.bot.entities)) {
            if (!e) continue;
            const type = (e as any).type;
            if (type === 'player' || (e as any) === this.bot.entity) continue;
            const name = ((e as any).name ?? type ?? 'entity').toString();
            const d = pos.distanceTo(e.position);
            if (d > radius) continue;
            out.push({
                name,
                x: Math.round(e.position.x),
                y: Math.round(e.position.y),
                z: Math.round(e.position.z),
                distance: d,
            });
        }
        out.sort((a, b) => a.distance - b.distance);
        return out.slice(0, limit);
    }

    private findNearbyBlocks(radius: number, limit: number): Array<{ name: string; x: number; y: number; z: number }> {
        const pos = this.bot.entity?.position;
        if (!pos) return [];
        const seen = new Set<string>();
        const names = ['log', 'stone', 'coal_ore', 'iron_ore', 'crafting_table', 'water'];
        const out: Array<{ name: string; x: number; y: number; z: number }> = [];
        for (const name of names) {
            const block = this.bot.findBlock({ matching: (b: any) => b?.name?.includes(name) ?? false, maxDistance: radius });
            if (!block) continue;
            const key = `${block.position.x},${block.position.y},${block.position.z}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ name: block.name, x: block.position.x, y: block.position.y, z: block.position.z });
            if (out.length >= limit) break;
        }
        return out;
    }

    private findLand(radius: number): { x: number; y: number; z: number } | null {
        const pos = this.bot.entity.position;
        for (let r = 2; r <= radius; r += 2) {
            for (let a = 0; a < 360; a += 45) {
                const rad = a * Math.PI / 180;
                const tx = Math.round(pos.x + r * Math.cos(rad));
                const tz = Math.round(pos.z + r * Math.sin(rad));
                const tp = pos.floored().offset(tx - pos.x, 0, tz - pos.z);
                const feet = this.bot.blockAt(tp);
                if (!feet || (feet.name?.includes('water') ?? false)) continue;
                const ground = this.bot.blockAt(tp.offset(0, -1, 0));
                if (!ground || ground.name === 'air' || (ground.name?.includes('water') ?? false)) continue;
                return { x: tp.x, y: ground.position.y + 1, z: tp.z };
            }
        }
        return null;
    }

    private execClear(clearTasks = true): void {
        if (clearTasks) this._taskQueue = [];
        this.bot.pathfinder?.stop();
        this.bot.clearControlStates();
    }

    private onEnd(): void {
        console.log('[V7] Disconnected');
        this.execClear(false);
        this.running = false;
        if (this._loopTimer) {
            clearTimeout(this._loopTimer);
            this._loopTimer = null;
        }
        if (this.config.autoReconnect) this.reconnect();
    }

    private reconnect(): void {
        this._reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(2, Math.min(this._reconnectAttempts, 5)), 120000);
        console.log(`[V7] Reconnect in ${(delay / 1000).toFixed(0)}s (attempt ${this._reconnectAttempts})`);
        setTimeout(() => {
            try { this.bot.removeAllListeners(); this.bot.quit(); } catch {}
            const newBot = mineflayer.createBot({
                host: this.config.host, port: this.config.port, username: this.config.username,
                version: this.config.version, auth: this.config.auth,
            });
            newBot.loadPlugin(pathfinder);
            try { newBot.loadPlugin((autoeat as any).loader || autoeat); } catch {}
            (this as any).bot = newBot;
            this.register(new MoveToSkill(newBot));
            this.register(new CollectSkill(newBot));
            this.register(new EatSkill(newBot));
            this.register(new RetreatSkill(newBot));
            this.register(new CraftSkill(newBot));
            this.register(new CraftChainSkill(newBot));
            this.bindBotEvents(newBot);
        }, delay);
    }
}

import { initLLM, callLLM, getModel, getProvider, listModels, setModel, setProviderKey } from "../utils/llm.js";
import type { BotConfig } from "../types/index.js";
import { McController, type MoveResult, type CollectResult } from "../interface/controller.js";
import { SkillLibrary } from "../memory/skill-library.js";
import { ExampleLibrary } from "../memory/example-library.js";
import { FailureMemory } from "../memory/failure-memory.js";
import { TaskPlannerContext } from "../planner/task-planner.js";
import { buildSubgoalPlan, type InventoryCounts } from "../planner/subgoal-planner.js";
import { formatRetrieved } from "../memory/retrieval.js";

type TaskItem = { type: string; params: any; retries: number };
type RuntimeTask =
  | { id: string; type: "follow_player"; status: "running"|"paused"|"interrupted"|"failed";
      targetPlayer: string; desiredDistance: number; tolerance: number; maxChaseDistance: number;
      lastKnownTargetPos?: { x: number; y: number; z: number };
      interruptReason?: string; lastError?: string; resumeAfterInterrupt: boolean; retries: number; updatedAt: number; }
  | { id: string; type: "search_target"; status: "running"|"paused"|"interrupted"|"failed";
      targetName: string; targetKind: "entity"|"block"; searchRadius: number; maxSearchDistance: number;
      exploreStepDistance: number; exploredSteps: number; anchorPos: { x: number; y: number; z: number };
      lastKnownTargetPos?: { x: number; y: number; z: number };
      interruptReason?: string; lastError?: string; resumeAfterInterrupt: boolean;
      onFoundAction?: { type: string; params: any } | null; retries: number; updatedAt: number; };

export class EvoBotV8Agent {
    readonly controller: McController;
    private config: BotConfig;
    private running = false;
    private _taskQueue: TaskItem[] = [];
    private _runtimeTask: RuntimeTask | null = null;
    private _currentTask: TaskItem | null = null;
    private _lastEvent = "";
    private _lastFailure: { taskType: string; params: any; detail: string; at: number } | null = null;
    private _emergencyActive = false;
    private _lastDecisionMs = 0;
    private _lastArrivalMs = 0;
    private _lastMoveTarget: { x: number; y: number; z: number } | null = null;
    private readonly _decisionCooldownMs = 2000;
    private readonly _arrivalCooldownMs = 1500;
    private _lastFollowGoalUpdateMs = 0;
    private _lastFollowTargetSnapshot: { x: number; y: number; z: number } | null = null;
    private _lastSearchGoalUpdateMs = 0;
    private _loopTimer: ReturnType<typeof setInterval> | null = null;
    private readonly _skillLibrary = new SkillLibrary();
    private readonly _exampleLibrary = new ExampleLibrary();
    private readonly _failureMemory = new FailureMemory();
    private readonly _plannerContext = new TaskPlannerContext(this._skillLibrary, this._exampleLibrary, this._failureMemory);

    constructor(config: BotConfig) {
        this.config = config;
        this.controller = new McController(config);
        initLLM(config);
    }

    async start(): Promise<void> {
        await this.controller.refreshState();
        this.running = true;
        this._loopTimer = setInterval(() => this.tick(), this.config.updateIntervalMs || 300);
    }

    stop(): void {
        this.running = false;
        if (this._loopTimer) { clearInterval(this._loopTimer); this._loopTimer = null; }
        this.controller.abortAll();
    }

    getModel(): string { return getModel(); }
    getProvider(): string { return getProvider(); }
    listModels(): string { return listModels(); }
    setModel(name: string): void { setModel(name); }
    setProviderKey(provider: string, key: string): void { setProviderKey(provider, key); }
    async chat(message: string): Promise<void> { await this.controller.chat(message); }
    async tap(key: string): Promise<void> { await this.controller.tap(key); }
    async hold(key: string, ms: number): Promise<void> { await this.controller.hold(key, ms); }
    async stopInputs(): Promise<void> { await this.controller.stopInputs(); }
    async look(yaw: number, pitch: number): Promise<void> { await this.controller.look(yaw, pitch); }
    async moveTo(x: number, y: number, z: number, reachDistance = 2): Promise<MoveResult> {
        return await this.controller.moveTo(x, y, z, reachDistance);
    }
    async selectHotbar(slot: number): Promise<void> { await this.controller.selectHotbar(slot); }
    async getRaycastSummary(): Promise<string> { return await this.controller.getRaycastSummary(); }
    async breakBlockNative(timeoutMs?: number) { return await this.controller.breakBlockNative(timeoutMs); }
    async attackEntityNative(target: string, timeoutMs?: number) { return await this.controller.attackEntityNative(target, timeoutMs); }
    async moveToNative(x: number, y: number, z: number, reachDistance?: number, timeoutMs?: number) { return await this.controller.moveToNative(x, y, z, reachDistance, timeoutMs); }
    async pathToNative(x: number, y: number, z: number, timeoutMs?: number) { return await this.controller.pathToNative(x, y, z, timeoutMs); }
    async useItemNative(holdMs?: number) { return await this.controller.useItemNative(holdMs); }
    async placeBlockNative(x: number, y: number, z: number) { return await this.controller.placeBlockNative(x, y, z); }
    async inventorySummary() { return await this.controller.inventorySummary(); }
    async selectItem(name: string) { return await this.controller.selectItem(name); }
    async openContainer(x: number, y: number, z: number) { return await this.controller.openContainer(x, y, z); }
    async containerItems() { return await this.controller.containerItems(); }
    async moveContainerItem(from: number, to: number) { return await this.controller.moveContainerItem(from, to); }
    async closeContainer() { return await this.controller.closeContainer(); }
    async worldTime() { return await this.controller.worldTime(); }
    async breakBlock(target: string, maxDistance?: number, timeoutMs?: number) { return await this.controller.breakBlock(target, maxDistance, timeoutMs); }
    async attackEntity(targetName: string, maxDistance?: number, timeoutMs?: number) { return await this.controller.attackEntity(targetName, maxDistance, timeoutMs); }
    async eat() { return await this.controller.eat(); }
    async craftRecipe(itemId: string, makeAll?: boolean) { return await this.controller.craftRecipe(itemId, makeAll); }
    async placeBlock(itemName: string) { return await this.controller.placeBlock(itemName); }
    async openBlock(blockName: string) { return await this.controller.openBlock(blockName); }
    findInInventory(itemId: string) { return this.controller.findInInventory(itemId); }
    countInInventory(itemId: string): number { return this.controller.countInInventory(itemId); }

    queueTask(type: string, params: any): void { this._taskQueue.push({ type, params, retries: 0 }); }
    replaceWithTask(type: string, params: any): void { this._taskQueue = [{ type, params, retries: 0 }]; }
    followPlayer(player?: string, distance = 12, tolerance = 2, maxDistance = 100): void {
        const s = this.controller.getStateSnapshot();
        const target = player || (s?.playerList || [])[0]?.name || "";
        if (!target) { console.warn("[v8] followPlayer: no target"); return; }
        this.applyFollowTask(target, distance, tolerance, maxDistance);
    }
    searchTarget(target: string, kind: "entity" | "block" = "entity", radius = 24, maxDistance = 100, stepDistance = 12): void {
        this.applySearchTask(target, kind, radius, maxDistance, stepDistance, this.defaultFollowupActionForSearch(target, kind));
    }
    clearRuntimeTask(): void {
        this._runtimeTask = null;
        this._lastFollowGoalUpdateMs = 0;
        this._lastFollowTargetSnapshot = null;
        this._lastSearchGoalUpdateMs = 0;
        void this.controller.stopInputs();
    }
    stopAll(): void {
        this.clearRuntimeTask();
        this._taskQueue = [];
        void this.controller.stopInputs();
        this._lastEvent = "STOP all work";
    }

    getStatusSummary(): string {
        const s = this.controller.getStateSnapshot();
        if (!s?.inGame) return "Backend: mc-api\nState: not in game";
        const rt = this._runtimeTask;
        return [
            "Backend: mc-api",
            `Pos: (${s.blockX}, ${s.blockY}, ${s.blockZ}) | Yaw/Pitch: ${s.yaw.toFixed(1)}/${s.pitch.toFixed(1)}`,
            `Health: ${s.health.toFixed(0)}/${s.maxHealth.toFixed(0)} | Food: ${s.foodLevel} | Armor: ${s.armor}`,
            `Server: ${s.serverAddress ?? "unknown"} | Gamemode: ${s.gamemode ?? "?"}`,
            `RuntimeTask: ${rt ? `${rt.type} [${rt.status}]` : "none"}`,
            `Queue: ${this._taskQueue.length} | Last: ${this._lastEvent || "none"}`,
        ].join("\n");
    }

    getTasksSummary(): string {
        const rt = this._runtimeTask;
        const rtStr = rt ? `${rt.type} status=${rt.status} ${rt.type === "follow_player" ? `target=${rt.targetPlayer}` : `target=${rt.targetName}`} retries=${rt.retries}` : "none";
        const queueStr = this._taskQueue.map((t, i) => `[${i}] ${t.type} ${JSON.stringify(t.params)} r${t.retries}`).join(", ") || "empty";
        return `Runtime: ${rtStr}\nQueue: ${queueStr}`;
    }

    getPlayersSummary(): string {
        const s = this.controller.getStateSnapshot();
        if (!s?.inGame) return "Players: none";
        const players = s.playerList || [];
        if (players.length === 0) return "Players: none";
        return ["Players:"].concat(players.map((p) => `- ${p.name} ping=${p.latency}`)).join("\n");
    }

    getEntitiesSummary(radius = 24, limit = 12): string {
        const s = this.controller.getStateSnapshot();
        if (!s?.inGame) return "Entities: none";
        const entities = (s.nearbyEntities || []).filter((e) => e.distance <= radius).slice(0, limit);
        if (entities.length === 0) return "Entities: none";
        return ["Entities:"].concat(entities.map((e) => `- ${e.name} @ (${Math.round(e.x)}, ${Math.round(e.y)}, ${Math.round(e.z)}) ${e.distance.toFixed(1)}m`)).join("\n");
    }

    getBlocksSummary(radius = 24, limit = 12): string {
        const s = this.controller.getStateSnapshot();
        if (!s?.inGame) return "Blocks: none";
        const blocks = (s.nearbyBlocks || []).filter((b) => b.distance <= radius).slice(0, limit);
        if (blocks.length === 0) return "Blocks: none";
        return ["Blocks:"].concat(blocks.map((b) => `- ${b.blockId} @ (${b.x}, ${b.y}, ${b.z}) ${b.distance.toFixed(1)}m`)).join("\n");
    }

    getScanSummary(query = "", radius = 24): string {
        const q = query.toLowerCase();
        const s = this.controller.getStateSnapshot();
        if (!s?.inGame) return "mc-api: not in game";
        const ents = (s.nearbyEntities || []).filter((e) => e.distance <= radius && (!q || e.name.toLowerCase().includes(q)))
            .map((e) => `${e.name}@(${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.z)}) ${e.distance.toFixed(1)}m`).join(", ") || "none";
        const blks = (s.nearbyBlocks || []).filter((b) => b.distance <= radius && (!q || b.name.toLowerCase().includes(q) || b.blockId.toLowerCase().includes(q)))
            .map((b) => `${b.blockId}@(${b.x},${b.y},${b.z}) ${b.distance.toFixed(1)}m`).join(", ") || "none";
        return [`Entities: ${ents}`, `Blocks: ${blks}`].join("\n");
    }

    getMemorySummary(query = ""): string {
        const state = this.buildStatePrompt();
        return [
            "Skill library: " + this._skillLibrary.list(),
            this._plannerContext.build(query || state, state),
        ].join("\n");
    }

    async getWebKnowledgeSummary(query: string): Promise<string> {
        const reply = await callLLM([{ role: "user", content: `Answer briefly: ${query}` }], { maxTokens: 120, temperature: 0.2 });
        return reply || "No external knowledge";
    }

    // ========== TICK LOOP ==========
    private async tick(): Promise<void> {
        if (!this.running) return;
        const s = await this.controller.refreshState();
        if (!s?.inGame) return;

        // Poll and handle chat messages
        await this.pollAndHandleChat();

        // Safety: low health retreat
        if (s.health <= this.config.criticalHealthThreshold) {
            if (!this._emergencyActive) {
                this._emergencyActive = true;
                try {
                    this.interruptRuntimeTask("critical_health");
                    const dx = s.x + (Math.random() > 0.5 ? 16 : -16);
                    const dz = s.z + (Math.random() > 0.5 ? 16 : -16);
                    const result = await this.controller.moveTo(Math.round(dx), Math.round(s.y), Math.round(dz), 2);
                    this._lastEvent = `${result.ok ? "OK" : "FAIL"} retreat: ${result.detail}`;
                } finally {
                    this.resumeRuntimeTaskIfPossible("critical_health");
                    this._emergencyActive = false;
                }
            }
            return;
        }

        // Safety: low hunger eat
        if (s.foodLevel <= this.config.hungerThreshold) {
            const result = await this.controller.eat();
            this._lastEvent = `eat: ${result.detail}`;
            return;
        }

        // Execute task queue
        if (this._taskQueue.length > 0) {
            const task = this._taskQueue[0];
            this._currentTask = task;
            const result = await this.executeSkill(task.type, task.params);
            this._lastEvent = `${result.ok ? "OK" : "FAIL"} ${task.type}: ${result.detail}`;
            if (result.ok) {
                this._lastFailure = null;
                this._taskQueue.shift();
            } else if (this.isRetryable(result) && task.retries < 2) {
                task.retries++;
                console.warn(`[v8] Retrying ${task.type} (${task.retries}/2)`);
            } else {
                this._lastFailure = { taskType: task.type, params: task.params, detail: result.detail, at: Date.now() };
                this._failureMemory.record(task.type, task.params, { ok: false, detail: result.detail, failureType: "internal_error" }, this.buildStatePrompt());
                this._taskQueue.shift();
            }
            if (result.ok && task.type === "move_to") {
                this._lastMoveTarget = { x: task.params.x, y: task.params.y, z: task.params.z };
                this._lastArrivalMs = Date.now();
            }
            this._currentTask = null;
            return;
        }

        // Tick runtime task
        if (await this.tickRuntimeTask()) return;

        // Early-game wood fallback
        const nearbyLog = (s.nearbyBlocks || []).find((b) => b.blockId.includes("log"));
        const woodCount = this.controller.countInInventory("log") + this.controller.countInInventory("planks");
        if (nearbyLog && woodCount < 6) {
            console.log("[plan] collect nearby log");
            this._taskQueue.push({ type: "collect", params: { target: "log", count: 1 }, retries: 0 });
            return;
        }

        // AI decision pacing
        const now = Date.now();
        if (now - this._lastDecisionMs < this._decisionCooldownMs) return;
        if (now - this._lastArrivalMs < this._arrivalCooldownMs) return;

        // AI decides
        const action = await this.askAI();
        this._lastDecisionMs = now;
        if (action) {
            if (action.type !== "wait") console.log(`[plan] ${action.type} ${JSON.stringify(action.params)}`);
            if (action.type === "follow_player") {
                this.applyFollowTask(action.params.player, action.params.desiredDistance ?? 12, action.params.tolerance ?? 2, action.params.maxChaseDistance ?? 100);
            } else if (action.type === "search_target") {
                this.applySearchTask(action.params.target, action.params.kind, action.params.radius, action.params.maxDistance, action.params.stepDistance, this.defaultFollowupActionForSearch(action.params.target, action.params.kind));
            } else {
                this._taskQueue.push({ ...action, retries: 0 });
            }
        }
    }

    // ========== SKILL EXECUTION ==========
    private async executeSkill(type: string, params: any): Promise<{ ok: boolean; detail: string }> {
        switch (type) {
            case "wait": return { ok: true, detail: "Waited" };
            case "stop": this.stopAll(); return { ok: true, detail: "Stopped" };
            case "move_to":
                return await this.controller.moveTo(params.x, params.y, params.z, params.reachDistance ?? 2);
            case "collect": {
                const target = String(params?.target || "log");
                const count = Math.max(1, Number(params?.count || 1));
                let successCount = 0;
                for (let i = 0; i < count; i++) {
                    const r = await this.controller.breakBlock(target, 5, 12000);
                    if (!r.ok) break;
                    successCount++;
                }
                return successCount > 0
                    ? { ok: true, detail: `Collected ${successCount}/${count} ${target}` }
                    : await this.controller.breakBlock(target, 5, 12000);
            }
            case "eat":
                return await this.controller.eat();
            case "retreat": {
                const s = this.controller.getStateSnapshot();
                if (!s) return { ok: false, detail: "No state" };
                const dist = params?.distance ?? 16;
                const dx = s.x + (Math.random() > 0.5 ? dist : -dist);
                const dz = s.z + (Math.random() > 0.5 ? dist : -dist);
                return await this.controller.moveTo(Math.round(dx), Math.round(s.y), Math.round(dz), 2);
            }
            case "attack_entity":
                return await this.controller.attackEntity(params?.target ?? "sheep", 5, 8000);
            case "follow_player":
                this.applyFollowTask(params.player, params.desiredDistance ?? 12, params.tolerance ?? 2, params.maxChaseDistance ?? 100);
                return { ok: true, detail: `Following ${params.player}` };
            case "search_target":
                this.applySearchTask(params.target, params.kind, params.radius, params.maxDistance, params.stepDistance, this.defaultFollowupActionForSearch(params.target, params.kind));
                return { ok: true, detail: `Searching for ${params.target}` };
            case "craft_recipe":
            case "craft_table":
            case "place_block":
            case "open_block":
                return await this.executeCraftSkill(type, params);
            default:
                return { ok: false, detail: `Unknown skill: ${type}` };
        }
    }

    private isRetryable(result: { ok: boolean; detail: string; failureType?: string }): boolean {
        if (result.ok) return false;
        return result.failureType === "stuck" || result.failureType === "timeout" || result.failureType === "path_stuck";
    }

    // ========== RUNTIME TASK ==========
    private applyFollowTask(player: string, desiredDistance: number, tolerance: number, maxChaseDistance: number): void {
        this._runtimeTask = {
            id: `follow_${Date.now()}`, type: "follow_player", status: "running",
            targetPlayer: player,
            desiredDistance: Math.max(1, Math.min(desiredDistance, 100)),
            tolerance: Math.max(0.5, Math.min(tolerance, 10)),
            maxChaseDistance: Math.max(5, Math.min(maxChaseDistance, 100)),
            resumeAfterInterrupt: true, retries: 0, updatedAt: Date.now(),
        };
        this._lastFollowGoalUpdateMs = 0;
        this._lastFollowTargetSnapshot = null;
        this._lastEvent = `TASK follow_player -> ${player}`;
    }

    private applySearchTask(targetName: string, kind: "entity" | "block", searchRadius: number, maxSearchDistance: number, exploreStepDistance: number, onFoundAction: { type: string; params: any } | null): void {
        const s = this.controller.getStateSnapshot();
        if (!s) return;
        this._runtimeTask = {
            id: `search_${Date.now()}`, type: "search_target", status: "running",
            targetName, targetKind: kind,
            searchRadius: Math.max(8, Math.min(searchRadius, 64)),
            maxSearchDistance: Math.max(8, Math.min(maxSearchDistance, 100)),
            exploreStepDistance: Math.max(4, Math.min(exploreStepDistance, 24)),
            exploredSteps: 0,
            anchorPos: { x: s.x, y: s.y, z: s.z },
            resumeAfterInterrupt: true, onFoundAction, retries: 0, updatedAt: Date.now(),
        };
        this._lastSearchGoalUpdateMs = 0;
        this._lastEvent = `TASK search_target -> ${targetName}`;
    }

    private interruptRuntimeTask(reason: string): void {
        if (!this._runtimeTask || this._runtimeTask.status !== "running") return;
        if (!this._runtimeTask.resumeAfterInterrupt) return;
        this._runtimeTask.status = "interrupted";
        this._runtimeTask.interruptReason = reason;
        this._runtimeTask.updatedAt = Date.now();
    }

    private resumeRuntimeTaskIfPossible(reason: string): void {
        if (!this._runtimeTask || this._runtimeTask.status !== "interrupted") return;
        if (this._runtimeTask.interruptReason !== reason) return;
        this._runtimeTask.status = "running";
        this._runtimeTask.interruptReason = undefined;
        this._runtimeTask.updatedAt = Date.now();
        this._lastFollowGoalUpdateMs = 0;
    }

    private async tickRuntimeTask(): Promise<boolean> {
        const task = this._runtimeTask;
        if (!task) return false;
        if (task.status !== "running") return true;
        if (task.type === "follow_player") return this.tickFollowPlayerTask(task);
        if (task.type === "search_target") return this.tickSearchTargetTask(task);
        return false;
    }

    private async tickFollowPlayerTask(task: Extract<RuntimeTask, { type: "follow_player" }>): Promise<boolean> {
        const s = this.controller.getStateSnapshot();
        if (!s?.inGame) return false;

        const targetEntity = (s.nearbyEntities || []).find(
            (e) => e.name.toLowerCase() === task.targetPlayer.toLowerCase()
        );
        if (!targetEntity) {
            task.status = "interrupted";
            task.interruptReason = "target_too_far";
            task.lastError = `Cannot see ${task.targetPlayer}`;
            this._lastEvent = `INTERRUPTED follow_player: ${task.lastError}`;
            return true;
        }

        const distance = targetEntity.distance;
        task.lastKnownTargetPos = { x: targetEntity.x, y: targetEntity.y, z: targetEntity.z };
        task.updatedAt = Date.now();

        if (distance > task.maxChaseDistance) {
            task.status = "interrupted";
            task.interruptReason = "target_too_far";
            task.lastError = `Target beyond max: ${distance.toFixed(1)}m`;
            this._lastEvent = `INTERRUPTED follow_player: ${task.lastError}`;
            return true;
        }

        if (Math.abs(distance - task.desiredDistance) <= task.tolerance) {
            this.controller.look(
                this.computeYawTo(s.x, s.z, targetEntity.x, targetEntity.z),
                this.computePitchTo(s.x, s.y + 1.5, s.z, targetEntity.x, targetEntity.y + 1, targetEntity.z)
            );
            this._lastEvent = `FOLLOW holding ${task.targetPlayer}`;
            return true;
        }

        if (Date.now() - this._lastFollowGoalUpdateMs > 1000) {
            void this.controller.moveTo(
                Math.round(targetEntity.x), Math.round(targetEntity.y), Math.round(targetEntity.z), task.desiredDistance
            );
            this._lastFollowGoalUpdateMs = Date.now();
        }

        this._lastEvent = `FOLLOW chasing ${task.targetPlayer} dist=${distance.toFixed(1)}m`;
        return true;
    }

    private async tickSearchTargetTask(task: Extract<RuntimeTask, { type: "search_target" }>): Promise<boolean> {
        const s = this.controller.getStateSnapshot();
        if (!s?.inGame) return false;

        const found = task.targetKind === "entity"
            ? (s.nearbyEntities || []).find((e) => e.name.toLowerCase().includes(task.targetName.toLowerCase()) && e.distance <= task.searchRadius && e.alive)
            : (s.nearbyBlocks || []).find((b) => b.blockId.includes(task.targetName) && b.distance <= task.searchRadius);

        if (found) {
            if (task.onFoundAction) {
                this._taskQueue = [{ ...task.onFoundAction, retries: 0 }];
                this._runtimeTask = null;
                this._lastEvent = `SEARCH found ${task.targetName}, enqueued ${task.onFoundAction.type}`;
            } else {
                this._lastEvent = `SEARCH found ${task.targetName} @ (${Math.round(found.x)}, ${Math.round(found.y)}, ${Math.round(found.z)})`;
            }
            return true;
        }

        const nextExplore = this.pickSearchExplorePoint(task);
        if (!nextExplore) {
            task.status = "failed";
            task.lastError = `Search exhausted for ${task.targetName}`;
            this._lastEvent = `FAILED search_target: ${task.lastError}`;
            return true;
        }

        if (Date.now() - this._lastSearchGoalUpdateMs > 1500) {
            void this.controller.moveTo(nextExplore.x, nextExplore.y, nextExplore.z, 2);
            this._lastSearchGoalUpdateMs = Date.now();
            task.exploredSteps++;
        }
        task.updatedAt = Date.now();
        this._lastEvent = `SEARCH exploring for ${task.targetName} step=${task.exploredSteps}`;
        return true;
    }

    private pickSearchExplorePoint(task: Extract<RuntimeTask, { type: "search_target" }>): { x: number; y: number; z: number } | null {
        const s = this.controller.getStateSnapshot();
        if (!s) return null;
        const base = task.anchorPos;
        const step = task.exploreStepDistance;
        const ring = Math.floor(task.exploredSteps / 8) + 1;
        const angleIndex = task.exploredSteps % 8;
        const angle = (Math.PI * 2 * angleIndex) / 8;
        const x = Math.round(base.x + Math.cos(angle) * step * ring);
        const z = Math.round(base.z + Math.sin(angle) * step * ring);
        const totalDist = Math.sqrt((x - base.x) ** 2 + (z - base.z) ** 2);
        if (totalDist > task.maxSearchDistance) return null;
        return { x, y: Math.round(s.y), z };
    }

    private defaultFollowupActionForSearch(target: string, kind: "entity" | "block"): { type: string; params: any } | null {
        const normalized = target.toLowerCase();
        if (kind === "entity") {
            if (normalized.includes("sheep")) return { type: "attack_entity", params: { target: "sheep", count: 1 } };
            if (normalized.includes("pig")) return { type: "attack_entity", params: { target: "pig", count: 1 } };
        }
        if (kind === "block") {
            if (normalized.includes("log")) return { type: "collect", params: { target: "log", count: 1 } };
            if (normalized.includes("coal")) return { type: "collect", params: { target: "coal_ore", count: 1 } };
            if (normalized.includes("stone")) return { type: "collect", params: { target: "stone", count: 3 } };
        }
        return null;
    }

    // ========== LLM INTENT ENGINE ==========
    private buildStatePrompt(): string {
        const s = this.controller.getStateSnapshot();
        if (!s?.inGame) return "Not in game";

        const inv = (s.inventory || []).filter((i) => !i.empty).slice(0, 8)
            .map((i) => `${i.name} x${i.count}`).join(", ") || "empty";
        const hostile = (s.nearbyEntities || []).find((e) =>
            ["zombie", "skeleton", "spider", "creeper"].some((h) => e.name.toLowerCase().includes(h))
        );
        const hostileStr = hostile ? `${hostile.name} ${hostile.distance.toFixed(1)}m` : "none";
        const blockStr = (s.nearbyBlocks || []).slice(0, 6)
            .map((b) => `${b.blockId}@(${b.x},${b.y},${b.z}) ${b.distance.toFixed(1)}m`).join(", ") || "none";
        const playerStr = (s.playerList || []).slice(0, 4).map((p) => p.name).join(", ") || "none";
        const entityStr = (s.nearbyEntities || []).slice(0, 6)
            .map((e) => `${e.name}@(${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.z)}) ${e.distance.toFixed(1)}m`).join(", ") || "none";
        const lastMove = this._lastMoveTarget
            ? `(${this._lastMoveTarget.x}, ${this._lastMoveTarget.y}, ${this._lastMoveTarget.z})` : "none";

        return [
            `HP: ${s.health.toFixed(0)}/${s.maxHealth.toFixed(0)} | Food: ${s.foodLevel}`,
            `Pos: (${Math.round(s.x)}, ${Math.round(s.y)}, ${Math.round(s.z)})`,
            `Inv: ${inv}`,
            `Players: ${playerStr}`,
            `Entities: ${entityStr}`,
            `Hostile: ${hostileStr}`,
            `Nearby blocks: ${blockStr}`,
            `Last move target: ${lastMove}`,
            `Last event: ${this._lastEvent || "none"}`,
        ].join("\n");
    }

    private async askAI(): Promise<{ type: string; params: any } | null> {
        const state = this.buildStatePrompt();
        const s = this.controller.getStateSnapshot();
        if (!s?.inGame) return null;

        const memoryContext = this._plannerContext.build(state, state);

        console.log(`[think] HP=${s.health.toFixed(0)} FD=${s.foodLevel} Pos=(${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.z)}) Q=${this._taskQueue.length} ${getProvider()}/${getModel()}`);

        const prompt = `You are EvoBot v8, a Minecraft bot. Decide the next action.

State:
${state}

Retrieved memory/context:
${memoryContext}

Supported intents:
- move_to {"intent":"move_to","supported":true,"x":NUM,"y":NUM,"z":NUM}
- follow_player {"intent":"follow_player","supported":true,"player":"NAME","distance":12,"tolerance":2}
- search_target {"intent":"search_target","supported":true,"target":"sheep","kind":"entity","radius":24,"maxDistance":100,"stepDistance":12}
- collect {"intent":"collect","supported":true,"target":"log","count":1}
- eat {"intent":"eat","supported":true}
- retreat {"intent":"retreat","supported":true,"distance":16}
- wait {"intent":"wait","supported":true}
- refuse {"intent":"refuse","supported":false,"reason":"missing_skill","fallback":"wait"}

IMPORTANT:
- Prefer moving toward nearby players, entities, or useful blocks. Do NOT pick arbitrary coordinates.
- If nearby blocks include logs and inventory wood is low, collect log.
- Avoid reversing direction from "Last move target". Coords must be integers.`;

        const reply = await callLLM([
            { role: "system", content: "You are a Minecraft bot AI. Respond with ONLY valid JSON, no other text." },
            { role: "user", content: prompt },
        ], { maxTokens: 150, temperature: 0.3 });

        if (reply) console.log(`[think] ${reply}`);
        if (!reply) return this.buildAutonomousFallback();

        const defaultPlayer = (s.playerList || [])[0]?.name ?? "";
        const intent = this.parseGenericIntent(reply, "(autonomous)", defaultPlayer);
        if (!intent) return this.buildAutonomousFallback();
        if (!intent.supported) {
            this._lastEvent = `REFUSED autonomous: ${intent.reason ?? "unsupported"}`;
            return { type: "wait", params: {} };
        }

        return this.intentToAction(intent, defaultPlayer);
    }

    private parseGenericIntent(raw: string, message: string, defaultPlayer: string): any | null {
        const json = this.extractJsonObject(raw);
        if (!json) return null;
        try {
            const j = JSON.parse(json);
            return {
                intent: j.intent ?? "chat_only",
                supported: j.supported !== false,
                reason: j.reason,
                fallback: j.fallback,
                reply: j.reply ?? "",
                confidence: typeof j.confidence === "number" ? j.confidence : 0.8,
                player: j.player ?? defaultPlayer,
                distance: j.distance, tolerance: j.tolerance, maxDistance: j.maxDistance,
                kind: j.kind, radius: j.radius, stepDistance: j.stepDistance,
                x: j.x, y: j.y, z: j.z,
                target: j.target, count: j.count, item: j.item,
                originalMessage: message,
            };
        } catch { return null; }
    }

    private extractJsonObject(raw: string): string | null {
        const clean = raw.replace(/```[\w]*\n?/g, "").replace(/```/g, "").trim();
        const m = clean.match(/\{[\s\S]*\}/);
        if (!m) return null;
        const candidate = m[0].trim();
        try { JSON.parse(candidate); return candidate; } catch { /* repair below */ }

        let repaired = candidate
            .replace(/["""]/g, "\"")
            .replace(/,(\s*[}\]])/g, "$1")
            .replace(/"(-?\d+(?:\.\d+)?)"(?=\s*[},])/g, "$1")
            .replace(/:\s*"(true|false|null)"(?=\s*[},])/gi, ": $1");

        const quoteCount = (repaired.match(/"/g) || []).length;
        if (quoteCount % 2 === 1) repaired += "\"";

        const openBraces = (repaired.match(/\{/g) || []).length;
        const closeBraces = (repaired.match(/\}/g) || []).length;
        if (closeBraces < openBraces) repaired += "}".repeat(openBraces - closeBraces);

        try { JSON.parse(repaired); return repaired; } catch { return null; }
    }

    private buildAutonomousFallback(): { type: string; params: any } | null {
        const s = this.controller.getStateSnapshot();
        if (!s?.inGame) return null;

        const nearEntity = (s.nearbyEntities || []).find((e) =>
            ["sheep", "pig", "cow", "chicken"].some((a) => e.name.toLowerCase().includes(a))
        );
        const nearBlock = (s.nearbyBlocks || []).find((b) =>
            ["log", "coal_ore", "crafting_table"].some((n) => b.blockId.includes(n))
        );

        if (nearEntity) return { type: "move_to", params: { x: Math.round(nearEntity.x), y: Math.round(nearEntity.y), z: Math.round(nearEntity.z), reachDistance: 2 } };
        if (nearBlock) return { type: "move_to", params: { x: nearBlock.x, y: nearBlock.y, z: nearBlock.z, reachDistance: 2 } };
        return { type: "move_to", params: { x: Math.round(s.x + 4), y: Math.round(s.y), z: Math.round(s.z), reachDistance: 2 } };
    }

    private intentToAction(intent: any, username: string): { type: string; params: any } | null {
        switch (intent.intent) {
            case "follow_player":
                return { type: "follow_player", params: { player: intent.player || username, desiredDistance: intent.distance ?? 12, tolerance: intent.tolerance ?? 2, maxChaseDistance: intent.maxDistance ?? 100 } };
            case "search_target":
                return { type: "search_target", params: { target: intent.target, kind: intent.kind === "block" ? "block" : "entity", radius: intent.radius ?? 24, maxDistance: intent.maxDistance ?? 100, stepDistance: intent.stepDistance ?? 12 } };
            case "move_to":
                return { type: "move_to", params: { x: intent.x, y: intent.y, z: intent.z, reachDistance: 2 } };
            case "collect":
                return { type: "collect", params: { target: intent.target, count: intent.count ?? 1 } };
            case "eat":
                return { type: "eat", params: {} };
            case "retreat":
                return { type: "retreat", params: { distance: intent.distance ?? 16 } };
            case "wait":
                return { type: "wait", params: {} };
            case "craft_recipe":
                return { type: "craft_recipe", params: { item: intent.item, makeAll: intent.makeAll ?? false } };
            case "craft_table":
                return { type: "craft_table", params: { item: intent.item } };
            case "place_block":
                return { type: "place_block", params: { block: intent.block ?? intent.item } };
            case "open_block":
                return { type: "open_block", params: { block: intent.block ?? intent.item } };
            case "stop":
                return { type: "stop", params: {} };
            default:
                return null;
        }
    }

    // ========== HELPERS ==========
    private planFailureRecovery(username: string): any | null {
        const failure = this._lastFailure;
        if (!failure) return null;

        if (failure.taskType === "collect" && String(failure.params?.target || "").includes("log")) {
            return { intent: "search_target", supported: true, confidence: 0.95, reply: "last wood collection failed; searching for a reachable log", target: "log", kind: "block", radius: 24, maxDistance: 100, stepDistance: 12 };
        }
        if (failure.taskType === "collect" && String(failure.params?.target || "").includes("stone")) {
            return { intent: "search_target", supported: true, confidence: 0.95, reply: "stone collection failed; searching for closer stone", target: "stone", kind: "block", radius: 24, maxDistance: 100, stepDistance: 12 };
        }
        if (failure.taskType === "move_to") {
            return { intent: "follow_player", supported: true, confidence: 0.9, reply: "moving failed; I will follow you instead", player: username, distance: 4, tolerance: 2 };
        }
        return { intent: "chat_only", supported: true, confidence: 0.8, reply: "The last task failed: " + failure.taskType + ". Give me a smaller step or try differently." };
    }

    private computeYawTo(x: number, z: number, tx: number, tz: number): number {
        return Math.atan2(tz - z, tx - x) * 180 / Math.PI - 90;
    }

    private computePitchTo(x: number, y: number, z: number, tx: number, ty: number, tz: number): number {
        const dx = tx - x;
        const dy = ty - y;
        const dz = tz - z;
        return -Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180 / Math.PI;
    }

    // ========== CRAFTING SKILLS ==========
    private getInventoryCounts(): InventoryCounts {
        const out: InventoryCounts = {};
        const s = this.controller.getStateSnapshot();
        if (!s?.inGame) return out;
        for (const item of s.inventory || []) {
            if (item.empty) continue;
            const name = item.name.toLowerCase();
            out[name] = (out[name] || 0) + item.count;
        }
        return out;
    }

    private async executeCraftSkill(type: string, params: any): Promise<{ ok: boolean; detail: string }> {
        // Try subgoal expansion for high-value craft targets
        if (type === "craft_recipe" || type === "craft_table") {
            const item = params?.item;
            if (item && ["crafting_table", "wooden_pickaxe", "stone_pickaxe", "furnace"].includes(item)) {
                const inv = this.getInventoryCounts();
                const plan = buildSubgoalPlan(item, inv);
                if (plan && plan.length > 0) {
                    console.log(`[planner] expanding ${item} to ${plan.length} subgoals`);
                    this._taskQueue = plan.map((step) => ({ ...step, retries: 0 }));
                    return { ok: true, detail: `Expanded ${item} to ${plan.length} subgoal steps` };
                }
            }
        }

        switch (type) {
            case "craft_recipe": {
                const item = params?.item;
                if (!item) return { ok: false, detail: "No item specified" };
                return await this.controller.craftRecipe(item, params?.makeAll ?? false);
            }
            case "place_block": {
                const block = params?.block;
                if (!block) return { ok: false, detail: "No block specified" };
                return await this.controller.placeBlock(block);
            }
            case "open_block": {
                const block = params?.block;
                if (!block) return { ok: false, detail: "No block specified" };
                return await this.controller.openBlock(block);
            }
            case "craft_table": {
                // Chain: place crafting_table -> open it -> craft recipe
                const item = params?.item;
                if (!item) return { ok: false, detail: "No item to craft" };
                const placeResult = await this.controller.placeBlock("crafting_table");
                if (!placeResult.ok) return placeResult;
                await this.controller.sleep(500);
                const openResult = await this.controller.openBlock("crafting_table");
                if (!openResult.ok) return openResult;
                await this.controller.sleep(500);
                return await this.controller.craftRecipe(item);
            }
            default:
                return { ok: false, detail: "Unknown craft skill: " + type };
        }
    }

    // ========== CHAT HANDLER ==========
    private _lastChatTimestamp = 0;
    private _chatPollCount = 0;

    private async pollAndHandleChat(): Promise<void> {
        // Only poll every ~3s
        this._chatPollCount++;
        if (this._chatPollCount % 6 !== 0) return;

        try {
            const messages = await this.controller.getChatHistory(10);
            for (const msg of messages) {
                if (msg.timestamp <= this._lastChatTimestamp) continue;
                this._lastChatTimestamp = msg.timestamp;
                if (msg.username === "EvoBot" || msg.username === "[Game]") continue;
                await this.handleChat(msg.username, msg.message);
            }
        } catch {
            // Silently ignore poll failures
        }
    }

    async handleChat(username: string, message: string): Promise<void> {
        console.log("[chat] <" + username + "> " + message);

        const directIntent = this.parseDirectChatIntent(message, username);
        if (directIntent) {
            this.executeChatIntent(directIntent, message, username, "[rule]");
            return;
        }

        const state = this.buildStatePrompt();
        const memoryContext = this._plannerContext.build(message, state);
        const prompt = `You are a Minecraft bot. A player is talking to you.

Your state:
${state}

Retrieved memory/context:
${memoryContext}

Player <${username}>: "${message}"

Supported actions:
- follow_player  - move_to  - search_target  - collect  - craft_recipe  - craft_table
- place_block    - eat     - retreat       - stop     - chat_only

If you cannot extract a safe action, use chat_only.
Respond with JSON only:
{"reply":"your chat reply","intent":"chat_only","supported":true}
{"reply":"on my way","intent":"follow_player","supported":true,"player":"Jacky_MC_","distance":12,"tolerance":2}
{"reply":"ok coming!","intent":"move_to","supported":true,"x":0,"y":64,"z":0}
{"reply":"getting wood","intent":"collect","supported":true,"target":"log","count":1}
{"reply":"making a pickaxe","intent":"craft_table","supported":true,"item":"wooden_pickaxe"}
{"reply":"I can't build a house yet","intent":"refuse","supported":false,"reason":"missing_skill","fallback":"collect log"}`;

        const reply = await callLLM([
            { role: "system", content: "You are a Minecraft bot. Reply in JSON with reply (1 sentence) and optional action." },
            { role: "user", content: prompt },
        ], { maxTokens: 200, temperature: 0.7 });

        if (!reply) {
            await this.controller.chat("Hmm, I did not catch that.");
            return;
        }

        const chatIntent = this.parseGenericIntent(reply, message, username);
        if (chatIntent) {
            this.executeChatIntent(chatIntent, message, username, reply);
        } else {
            await this.controller.chat(reply.slice(0, 100));
        }
    }

    private parseDirectChatIntent(message: string, username: string): any | null {
        const compact = message.trim().toLowerCase().replace(/[!?.,]/g, " ").replace(/\s+/g, " ").trim();
        const s = this.controller.getStateSnapshot();

        if (/(follow me|follow)/.test(compact)) {
            return { intent: "follow_player", supported: true, reply: "on my way", player: username, distance: 12, tolerance: 2, confidence: 0.95 };
        }
        if (/(come here|come to me|come|here)/.test(compact) && s) {
            return { intent: "move_to", supported: true, reply: "coming!", confidence: 0.95, x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z) };
        }
        if (/(report|status)/.test(compact)) {
            return { intent: "chat_only", supported: true, confidence: 0.95, reply: this.getStatusSummary().replace(/\n+/g, " ").slice(0, 180) };
        }
        if (/(scan|look around|what do you see)/.test(compact)) {
            return { intent: "chat_only", supported: true, confidence: 0.95, reply: this.getScanSummary("", 16).replace(/\n+/g, " ").slice(0, 220) };
        }
        if (/(collect|get|gather).*(wood|log)/.test(compact)) {
            return { intent: "collect", supported: true, confidence: 0.9, reply: "getting wood", target: "log", count: 1 };
        }
        if (/(craft|make).*(pickaxe|wooden_pickaxe|stone_pickaxe)/.test(compact)) {
            const item = compact.includes("stone") ? "stone_pickaxe" : "wooden_pickaxe";
            return { intent: "craft_table", supported: true, confidence: 0.9, reply: "making " + item, item };
        }
        if (/(craft|make).*(crafting_table|workbench|table)/.test(compact)) {
            return { intent: "craft_recipe", supported: true, confidence: 0.9, reply: "making crafting table", item: "crafting_table" };
        }
        if (/(didnt work|didn't work|not working|failed|没用|失败了)/.test(compact)) {
            if (this._lastFailure) {
                const corrective = this.planFailureRecovery(username);
                if (corrective) return corrective;
            }
            const memory = this._plannerContext.build(compact, this.buildStatePrompt()).replace(/\n+/g, " ").slice(0, 160);
            return { intent: "chat_only", supported: true, confidence: 0.85, reply: "I see it failed. Recent context: " + memory };
        }
        if (/(use|equip).*(axe)|axe/.test(compact)) {
            const hasAxe = this.controller.countInInventory("axe") > 0;
            return { intent: "chat_only", supported: true, confidence: 0.9, reply: hasAxe ? "I have an axe, I will use it for chopping." : "I do not have an axe right now." };
        }
        if (/(crafting_table|workbench|table)/.test(compact) && !/(craft|make)/.test(compact)) {
            const hasTable = this.controller.countInInventory("crafting_table") > 0;
            return { intent: "chat_only", supported: true, confidence: 0.9, reply: hasTable ? "Yes, I have a crafting table." : "No crafting table in inventory." };
        }
        if (/(introduce yourself|who are you)/.test(compact)) {
            return { intent: "chat_only", supported: true, confidence: 0.95, reply: "I'm EvoBot v8, a Minecraft helper bot. I can follow you, collect resources, craft items, and more." };
        }

        return null;
    }

    private executeChatIntent(chatIntent: any, message: string, username: string, rawReply: string): void {
        const chatMsg = chatIntent.reply || "";
        if (chatMsg && chatMsg !== "wait") {
            void this.controller.chat(chatMsg);
            console.log("[chat] <EvoBot> " + chatMsg);
        }
        if (!chatIntent.supported) {
            console.log("[chat] refused: " + (chatIntent.reason ?? "unsupported"));
            return;
        }
        const action = this.intentToAction(chatIntent, username);
        if (!action || action.type === "wait") return;
        if (action.type === "follow_player") {
            this.applyFollowTask(action.params.player || username, action.params.desiredDistance ?? 12, action.params.tolerance ?? 2, action.params.maxChaseDistance ?? 100);
            this._taskQueue = [];
        } else if (action.type === "search_target") {
            this.applySearchTask(action.params.target, action.params.kind, action.params.radius, action.params.maxDistance, action.params.stepDistance, this.defaultFollowupActionForSearch(action.params.target, action.params.kind));
            this._taskQueue = [];
        } else if (action.type === "stop") {
            this.clearRuntimeTask();
            this._taskQueue = [];
        } else {
            this._taskQueue = [{ ...action, retries: 0 }];
        }
        console.log("[chat] enqueued: " + action.type + " " + JSON.stringify(action.params));
    }
}

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
import { initLLM, callLLM, getModel, setModel, listModels } from '../utils/llm.js';
import { isFiniteVec3 } from '../utils/nan-guard.js';
import type { BotConfig, SkillResult } from '../types/index.js';

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

type AnySkill = MoveToSkill | CollectSkill | EatSkill | RetreatSkill | CraftSkill;

export class EvoBotV7 {
    readonly bot: Bot;
    private config: BotConfig;
    private skills = new Map<string, AnySkill>();
    private running = false;
    private _taskQueue: Array<{ type: string; params: any }> = [];
    private _prevHealth = 20;
    private _reconnectAttempts = 0;
    private _inWater = false;
    private _lastEvent = '';
    private _logDir = 'logs';

    // Decision/movement pacing (prevents erratic running)
    private _lastDecisionMs = 0;
    private _lastArrivalMs = 0;
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

        initLLM(config);
        this.setupEvents();
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
    setModel(name: string): void { setModel(name); }
    listModels(): string { return listModels(); }

    private setupEvents(): void {
        this.bot.once('spawn', () => this.onSpawn());
        this.bot.on('end', () => this.onEnd());
        this.bot.on('error', (e: Error) => console.error(`[V7] ${e.message}`));
        this.bot.on('health', () => {
            const hp = this.bot.health;
            if (hp < this._prevHealth && hp <= this.config.lowHealthThreshold) {
                this.bot.pathfinder?.stop();
                attackNearestHostile(this.bot);
            }
            this._prevHealth = hp;
        });
        this.bot.on('death', () => {
            console.warn('[V7] Died');
            this.execClear();
        });
        this.bot.on('chat', (username: string, msg: string) => {
            if (username === this.bot.username) return;
            this.handleChat(username, msg);
        });
    }

    private async onSpawn(): Promise<void> {
        console.log('[V7] Spawned');
        this.running = true;
        this._reconnectAttempts = 0;

        const mcData = require('minecraft-data')(this.bot.version);
        const { Movements } = require('mineflayer-pathfinder');
        const moves = new Movements(this.bot, mcData);
        moves.canDig = false;
        moves.allowParkour = false;
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
        const tick = async () => {
            if (!this.running) return;
            try { await this.tick(); } catch (e) { console.error('[V7] Tick error:', (e as Error).message); }
            setTimeout(tick, this.config.updateIntervalMs);
        };
        tick();
    }

    private async tick(): Promise<void> {
        const pos = this.bot.entity?.position;
        if (!pos || !isFiniteVec3(pos)) return;

        // ── Safety (hardcoded, no AI) ──
        const feet = this.bot.blockAt(pos);
        const water = feet && (feet.name?.includes('water') ?? false);
        if (water && !this._inWater) {
            this._inWater = true;
            console.warn('[V7] In water — escaping');
            this.bot.pathfinder?.stop();
            this.bot.clearControlStates();
            const land = this.findLand(10);
            const GN = getGoalNear();
            if (land && GN) {
                this.bot.pathfinder.goto(new GN(land.x, land.y, land.z, 2)).catch(() => {});
            }
            return;
        }
        this._inWater = false;

        const health = this.bot.health ?? 20;
        if (health <= this.config.criticalHealthThreshold) {
            this.runSkill('retreat', { distance: 16 });
            return;
        }

        // ── Execute queued tasks ──
        if (this._taskQueue.length > 0) {
            const task = this._taskQueue[0];
            const result = await this.runSkill(task.type, task.params);
            console.log(`[V7] ${result.ok ? 'OK' : 'FAIL'} ${task.type}: ${result.detail}`);
            this._taskQueue.shift();
            this._lastEvent = `${result.ok ? 'OK' : 'FAIL'} ${task.type}: ${result.detail}`;
            if (task.type === 'move_to' || task.type === 'explore') this._lastArrivalMs = Date.now();
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
        if (action) this._taskQueue.push(action);
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
        const nearby = p ? this.bot.findBlock({ matching: (b: any) => !!b && b.name !== 'air', maxDistance: 8 }) : null;
        const blockStr = nearby ? `${nearby.name}` : 'none';
        return `HP: ${hp}/${fd}
Pos: ${posStr}
Inv: ${invStr}
Hostile: ${hostileStr}
Block ahead: ${blockStr}
Last event: ${this._lastEvent || 'none'}`;
    }

    private async askAI(): Promise<{ type: string; params: any } | null> {
        const state = this.buildStatePrompt();
        const p = this.bot.entity?.position;
        const hp = ((this.bot.health ?? 20).toFixed(0));
        const fd = ((this.bot.food ?? 20).toFixed(0));
        const ps = p ? `(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})` : '(?,?,?)';
        console.log(`[think] HP=${hp} FD=${fd} Pos=${ps} Q=${this._taskQueue.length} Model=${getModel()}`);

        const prompt = `You are EvoBot v7, a Minecraft bot. Decide the next action.

State:
${state}

Available actions (JSON only):
{"do":"explore"}                           — walk 8-16 blocks in a random direction (bot picks safe coords)
{"do":"move_to","x":NUM,"y":NUM,"z":NUM}  — walk to specific coordinates (only if player/task gave them)
{"do":"collect","target":"log"}            — mine nearest block (try: log, stone, cobblestone, coal_ore, iron_ore)
{"do":"eat"}                               — eat food from inventory
{"do":"craft","item":"stone_pickaxe"}       — craft item (planks, stick, crafting_table, wooden_pickaxe, stone_pickaxe, furnace)
{"do":"retreat","distance":16}             — run from danger
{"do":"wait"}                              — skip tick (only if busy)

IMPORTANT:
- Prefer explore when idle. The bot will commit to one direction and not change its mind for a few seconds.
- Only use move_to if you have a real destination. Do NOT ping-pong between nearby points.
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

        if (!reply) return { type: 'wait', params: {} };
        return this.parseAction(reply);
    }

    /** Chat handler: LLM can both reply in text AND submit an action */
    private async handleChat(username: string, message: string): Promise<void> {
        const p = this.bot.entity?.position;
        this._log('chat.jsonl', { type: 'user', username, message, pos: p ? { x: p.x, y: p.y, z: p.z } : null });
        console.log(`[chat] <${username}> ${message}`);

        const state = this.buildStatePrompt();
        const prompt = `You are a Minecraft bot. A player is talking to you.

Your state:
${state}

Player <${username}>: "${message}"

Respond with JSON (no other text):
{"reply":"your chat reply","do":"wait"} — just chat, no action
{"reply":"ok coming!","do":"move_to","x":0,"y":64,"z":0} — chat AND move
{"reply":"here you go","do":"collect","target":"log"} — chat AND collect
{"reply":"on it","do":"craft","item":"wooden_pickaxe"} — chat AND craft
{"reply":"exploring!","do":"explore"} — chat AND explore
{"do":"retreat","reply":"help!",distance":16} — chat AND retreat`;

        const reply = await callLLM([
            { role: 'system', content: 'You are a Minecraft bot. Reply in JSON with "reply" (1 sentence) and optional action.' },
            { role: 'user', content: prompt },
        ], { maxTokens: 200, temperature: 0.7 });

        if (!reply) return;

        // Try to parse JSON; if fails, treat entire reply as chat text
        const action = this.parseAction(reply);
        if (action) {
            const chatMsg = (action as any)._reply || '';
            if (chatMsg && chatMsg !== 'wait') {
                this.bot.chat(chatMsg);
                console.log(`[chat] <EvoBot> ${chatMsg}`);
                this._log('chat.jsonl', { type: 'bot_reply', to: username, reply: chatMsg, rawLLM: reply });
            }
            // Enqueue action (skip if it's a chat-only message)
            if (action.type !== 'wait' || (action as any)._reply) {
                if (action.type !== 'wait') {
                    this._taskQueue = [action]; // replace queue (player command priority)
                    console.log(`[chat] enqueued: ${action.type} ${JSON.stringify(action.params)}`);
                }
            }
        } else {
            // Failed to parse JSON — treat as plain text reply
            this.bot.chat(reply);
            console.log(`[chat] <EvoBot> ${reply}`);
            this._log('chat.jsonl', { type: 'bot_reply', to: username, reply, rawLLM: reply });
        }
    }

    /** Parse JSON action from LLM response */
    private parseAction(raw: string): { type: string; params: any; _reply?: string } | null {
        let clean = raw.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
        const m = clean.match(/\{[\s\S]*\}/);
        if (!m) return null;
        try {
            const j = JSON.parse(m[0]);
            const r: any = { type: 'wait', params: {}, _reply: j.reply };
            if (j.do === 'explore') { r.type = 'explore'; r.params = {}; }
            else if (j.do === 'move_to') { r.type = 'move_to'; r.params = { x: j.x, y: j.y, z: j.z, reachDistance: 2 }; }
            else if (j.do === 'collect') { r.type = 'collect'; r.params = { target: j.target, count: 1 }; }
            else if (j.do === 'eat') { r.type = 'eat'; r.params = {}; }
            else if (j.do === 'craft') { r.type = 'craft'; r.params = { item: j.item, count: 1 }; }
            else if (j.do === 'retreat') { r.type = 'retreat'; r.params = { distance: j.distance ?? 16 }; }
            return r;
        } catch { return null; }
    }

    private async runSkill(type: string, params: any): Promise<SkillResult> {
        if (type === 'wait') return { ok: true, detail: 'Waited one tick' };
        if (type === 'explore') {
            const target = this.pickExploreTarget();
            return this.runSkill('move_to', { x: target.x, y: target.y, z: target.z, reachDistance: 2 });
        }
        const s = this.skills.get(type);
        if (!s) return { ok: false, detail: `Unknown skill: ${type}` };
        return s.run(params);
    }

    private pickExploreTarget(): { x: number; y: number; z: number } {
        const p = this.bot.entity.position;
        const angle = Math.random() * Math.PI * 2;
        const dist = 8 + Math.random() * 8;
        return {
            x: Math.round(p.x + Math.cos(angle) * dist),
            y: Math.round(p.y),
            z: Math.round(p.z + Math.sin(angle) * dist),
        };
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

    private execClear(): void {
        this._taskQueue = [];
        this.bot.pathfinder?.stop();
        this.bot.clearControlStates();
    }

    private onEnd(): void {
        console.log('[V7] Disconnected');
        this.execClear();
        this.running = false;
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
            newBot.once('spawn', () => { this._reconnectAttempts = 0; this.onSpawn(); });
            newBot.on('end', () => this.onEnd());
            newBot.on('error', (e: Error) => console.error(`[V7] ${e.message}`));
            newBot.on('health', () => {
                const hp = newBot.health;
                if (hp < this._prevHealth && hp <= this.config.lowHealthThreshold) {
                    newBot.pathfinder?.stop();
                    attackNearestHostile(newBot);
                }
                this._prevHealth = hp;
            });
        }, delay);
    }
}

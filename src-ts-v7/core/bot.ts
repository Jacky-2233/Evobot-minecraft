import mineflayer, { Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import autoeat from 'mineflayer-auto-eat';
import { MoveToSkill, type MoveParams } from '../skills/movement.js';
import { CollectSkill, type CollectParams } from '../skills/collect.js';
import { EatSkill } from '../skills/eat.js';
import { RetreatSkill, attackNearestHostile } from '../skills/retreat.js';
import { CraftSkill } from '../skills/craft.js';
import { initLLM, callLLM } from '../utils/llm.js';
import { isFiniteVec3 } from '../utils/nan-guard.js';
import type { BotConfig, SkillResult } from '../types/index.js';

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
            this.thinkAndChat(username, msg);
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
            if (land) {
                this.bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals.GoalNear)(land.x, land.y, land.z, 2))
                    .catch(() => {});
            }
            return;
        }
        this._inWater = false;

        const health = this.bot.health ?? 20;
        const food = this.bot.food ?? 20;
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
            return;
        }

        // ── AI decides next action ──
        const action = await this.askAI();
        if (action) this._taskQueue.push(action);
    }

    private async askAI(): Promise<{ type: string; params: any } | null> {
        const p = this.bot.entity?.position;
        const inv = this.bot.inventory?.items()?.filter(Boolean) ?? [];
        const invStr = inv.slice(0, 8).map(i => `${(i as any).name ?? '?'} x${i.count}`).join(', ') || 'empty';
        const hostile = p ? this.findHostile(12) : null;
        const hostileStr = hostile ? `${hostile.name} ${hostile.distance.toFixed(1)}m` : 'none';

        const hp = ((this.bot.health ?? 20).toFixed(0));
        const fd = ((this.bot.food ?? 20).toFixed(0));
        const posStr = p ? `(${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})` : '(?, ?, ?)';
        const nearby = p ? this.bot.findBlock({ matching: (b: any) => !!b, maxDistance: 8 }) : null;
        const blockStr = nearby ? `${nearby.name}` : 'none';

        const prompt = `You are EvoBot v7, a Minecraft bot. Decide the next action.

State:
- HP: ${hp}/${fd}
- Pos: ${posStr}
- Inv: ${invStr}
- Hostile: ${hostileStr}
- Block ahead: ${blockStr}
- Last event: ${this._lastEvent || 'none'}

Available actions (respond with JSON only, no explanation):
{"do":"move_to","x":NUM,"y":NUM,"z":NUM}         — walk to coordinates
{"do":"collect","target":"log"}                   — mine nearest block matching name
{"do":"eat"}                                      — eat food
{"do":"craft","item":"stone_pickaxe"}             — craft item (planks/stick/crafting_table/wooden_pickaxe/stone_pickaxe/furnace)
{"do":"retreat","distance":16}                    — run away from threats
{"do":"wait"}                                     — do nothing this tick

Choose wisely based on state. Prioritize: survival > tools > resources > explore.`;

        const reply = await callLLM([
            { role: 'system', content: 'You are a Minecraft bot AI. Respond with ONLY valid JSON, no other text.' },
            { role: 'user', content: prompt },
        ], { maxTokens: 150, temperature: 0.3 });

        if (!reply) return { type: 'wait', params: {} };
        try {
            const j = JSON.parse(reply);
            if (j.do === 'wait' || !j.do) return { type: 'wait', params: {} };
            if (j.do === 'move_to') return { type: 'move_to', params: { x: j.x, y: j.y, z: j.z, reachDistance: 2 } };
            if (j.do === 'collect') return { type: 'collect', params: { target: j.target, count: 1 } };
            if (j.do === 'eat') return { type: 'eat', params: {} };
            if (j.do === 'craft') return { type: 'craft', params: { item: j.item, count: 1 } };
            if (j.do === 'retreat') return { type: 'retreat', params: { distance: j.distance ?? 16 } };
        } catch {}
        return { type: 'wait', params: {} };
    }

    private async thinkAndChat(username: string, message: string): Promise<void> {
        const p = this.bot.entity?.position;
        const prompt = `You are a Minecraft bot. Reply in 1 sentence.
HP=${this.bot.health?.toFixed(0)} Food=${this.bot.food?.toFixed(0)} Pos=(${p?.x.toFixed(0) ?? '?'},${p?.y.toFixed(0) ?? '?'},${p?.z.toFixed(0) ?? '?'})
Player <${username}>: "${message}"`;
        const reply = await callLLM([
            { role: 'system', content: 'You are a friendly Minecraft bot. Reply in 1 short sentence.' },
            { role: 'user', content: prompt },
        ], { maxTokens: 80, temperature: 0.8 });
        if (reply) { this.bot.chat(reply); console.log(`[V7] <${reply}>`); }
    }

    private async runSkill(type: string, params: any): Promise<SkillResult> {
        if (type === 'wait') return { ok: true, detail: 'Waited one tick' };
        const s = this.skills.get(type);
        if (!s) return { ok: false, detail: `Unknown skill: ${type}` };
        return s.run(params);
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

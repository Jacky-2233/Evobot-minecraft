const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const Movements = require('mineflayer-pathfinder').Movements;
const OpenAI = require('openai');

const { loadConfig } = require('./Config');
const Logger = require('../utils/logger');
const ModeController = require('./ModeController');
const TaskQueue = require('./TaskQueue');
const EvolutionSystem = require('./EvolutionSystem');
const ChatBrain = require('../ai/ChatBrain');
const Dashboard = require('../web/Dashboard');

const MovementSkill = require('../skills/movement');
const CombatSkill = require('../skills/combat');
const SurvivalSkill = require('../skills/survival');
const InventorySkill = require('../skills/inventory');
const GatherSkill = require('../skills/gather');
const FarmingSkill = require('../skills/farming');
const BuildingSkill = require('../skills/building');
const StorageSkill = require('../skills/storage');
const DangerAwareness = require('../skills/danger');
const IdleGoalPlanner = require('./IdleGoalPlanner');
const TaskPlanner = require('./TaskPlanner');
const MoodSystem = require('./MoodSystem');
const VisionSkill = require('../skills/vision');
const ViewerSkill = require('../skills/viewer');
const PrimitiveActions = require('../skills/primitive');
const SkillRegistry = require('./SkillRegistry');
const MemorySystem = require('./MemorySystem');

class Agent {
    constructor() {
        this.config = loadConfig();
        this.logger = new Logger();
        this.log = this.logger.log.bind(this.logger);
        this.bot = null;
        this.openai = new OpenAI({
            apiKey: this.config.ai.apiKey,
            baseURL: this.config.ai.baseURL,
        });
        this.skills = {};
        this.modes = null;
        this.taskQueue = null;
        this.evolution = null;
        this.chatBrain = null;
        this.dashboard = null;
        this.lastDamageTime = 0;
        this.intervals = [];
        this.danger = null;
        this.idlePlanner = null;
        this.taskPlanner = null;
        this.mood = null;
        this.idleStartTime = 0;
        this.skillRegistry = null;
        this.memory = null;
    }

    start() {
        this.cleanup();
        this.log('Starting EvoBot v5.0...');
        if (!this.config.ai.apiKey) {
            this.log('[WARN] No AI API key configured. AI chat will fail.');
        }

        this.bot = mineflayer.createBot(this.config.minecraft);
        this.bot.loadPlugin(pathfinder);

        this.bot.once('spawn', () => this.onSpawn());
        this.bot.on('login', () => this.log('Logged in!'));
        this.bot.on('error', (err) => this.log('Error:', err.message));
        this.bot.on('end', () => {
            this.log('Disconnected. Reconnecting...');
            this.cleanup();
            if (this.config.bot.autoReconnect) {
                setTimeout(() => this.start(), this.config.bot.reconnectDelay);
            }
        });
    }

    cleanup() {
        this.intervals.forEach(id => clearInterval(id));
        this.intervals = [];
        // Close web server
        try { this.dashboard?.server?.close(); } catch (e) {}
        try { this.dashboard?.wss?.close(); } catch (e) {}
        this.dashboard = null;
        if (this.bot) {
            try { this.bot.removeAllListeners(); } catch (e) {}
            try { this.bot.quit(); } catch (e) {}
            this.bot = null;
        }
    }

    async onSpawn() {
        this.log('Spawned!');
        setTimeout(() => {
            if (this.bot?.chat) this.bot.chat('EvoBot v5.0 is online!');
        }, 2000);

        // Setup pathfinder movements
        const mcData = require('minecraft-data')(this.bot.version);
        const defaultMove = new Movements(this.bot, mcData);
        defaultMove.canDig = false;
        defaultMove.digCost = 0;
        defaultMove.placeCost = 1;
        const originalSafe = defaultMove.safeToBreak;
        defaultMove.safeToBreak = (block) => {
            if (block.name.includes('leaves') || block.name.includes('log')) return true;
            return originalSafe.call(defaultMove, block);
        };
        this.bot.pathfinder.setMovements(defaultMove);

        // Initialize skills
        this.skills.movement = new MovementSkill(this);
        this.skills.combat = new CombatSkill(this);
        this.skills.combat.loadPlugin(); // PVP
        this.skills.survival = new SurvivalSkill(this);
        this.skills.survival.loadPlugin(); // auto-eat
        this.skills.inventory = new InventorySkill(this);
        this.skills.gather = new GatherSkill(this);
        this.skills.farming = new FarmingSkill(this);
        this.skills.building = new BuildingSkill(this);
        this.skills.storage = new StorageSkill(this);
        this.skills.vision = new VisionSkill(this);
        this.skills.viewer = new ViewerSkill(this);
        this.skills.primitive = new PrimitiveActions(this);

        // Initialize core systems
        this.taskQueue = new TaskQueue(this);
        this.modes = new ModeController(this);
        this.evolution = new EvolutionSystem(this.bot.username, this.log);
        this.chatBrain = new ChatBrain(this);
        this.dashboard = new Dashboard(this);
        this.dashboard.start();

        // New autonomous / safety / emotion systems
        this.danger = new DangerAwareness(this);
        this.idlePlanner = new IdleGoalPlanner(this);
        this.taskPlanner = new TaskPlanner(this);
        this.mood = new MoodSystem(this);
        this.skillRegistry = new SkillRegistry(this);
        this.skillRegistry.registerDefaults();
        this.memory = new MemorySystem(this);

        this.setupEvents();
        this.startUpdateLoop();

        const stats = this.evolution.getStats();
        this.log(`[Evolve] Loaded ${stats.skills} skills, ${stats.experiences} experiences`);
        this.log('Agent ready!');
    }

    setupEvents() {
        // Catch NaN as early as possible in physics tick
        this.bot.on('physicsTick', () => {
            if (!this.bot?.entity) return;
            const pos = this.bot.entity.position;
            if (Number.isNaN(pos.x) || Number.isNaN(pos.y) || Number.isNaN(pos.z)) {
                this.log('[CRITICAL] physicsTick Position NaN');
                this.cleanup();
                if (this.config.bot.autoReconnect) {
                    setTimeout(() => this.start(), this.config.bot.reconnectDelay);
                }
            }
        });

        let prevHealth = this.bot.health;
        this.bot.on('health', () => {
            if (this.bot.health < prevHealth) {
                this.lastDamageTime = Date.now();
                this.mood?.onEvent('damaged', { health: this.bot.health });
            }
            prevHealth = this.bot.health;
        });

        const handleChat = async (username, message) => {
            if (username === this.bot.username) return;
            this.mood?.onEvent('player_chat', { username });
            this.mood?.trust(username, 1);

            // Try task planner first; if it recognizes a chain, add it and still let AI reply.
            const chain = this.taskPlanner?.planFromIntent(message);
            if (chain && chain.length > 0) {
                this.log(`[Planner] Recognized chain: ${chain.map(t => t.type).join(' -> ')}`);
                for (const step of chain) {
                    this.taskQueue.add(step.type, step.params, step.options);
                }
            }

            try {
                await this.chatBrain.handleChat(username, message);
            } catch (e) {
                this.log('[Chat] Error:', e.message);
            }
        };
        this.bot.on('chat', handleChat);
        this.bot.on('whisper', handleChat);

        this.bot.on('death', () => {
            this.log('Died! Respawning...');
            this.taskQueue.clear();
            this.bot.pathfinder.stop();
            this.bot.clearControlStates();
            this.mood?.onEvent('died');
        });

        this.bot.on('playerCollect', (player, item) => {
            if (player.username === this.bot.username) {
                if (item?.name?.includes('diamond') || item?.name?.includes('emerald') || item?.name?.includes('iron_ingot')) {
                    this.mood?.onEvent('collected_rare', { item: item.name });
                }
            }
        });
    }

    startUpdateLoop() {
        const INTERVAL = this.config.bot.updateInterval;

        // Keep the world block-cache warm by periodically reading the block
        // at the bot's position. This is a belt-and-suspenders measure that
        // complements the physicsTick NaN guard above — in some server
        // environments, letting the world cache go stale appears to
        // contribute to physics timing issues.
        this.intervals.push(setInterval(() => {
            if (this.bot?.entity) {
                this.bot.blockAt(this.bot.entity.position);
            }
        }, 2000));

        this.intervals.push(setInterval(async () => {
            if (!this.bot?.entity) return;
            const pos = this.bot.entity.position;
            if (Number.isNaN(pos.x) || Number.isNaN(pos.y) || Number.isNaN(pos.z)) {
                this.log('[CRITICAL] Position NaN — forcing reconnect');
                this.cleanup();
                if (this.config.bot.autoReconnect) {
                    setTimeout(() => this.start(), this.config.bot.reconnectDelay);
                }
                return;
            }

            // Survival check
            await this.skills.survival.eatIfNeeded();
            await this.skills.survival.healIfCritical();
            this.skills.combat.equipArmor();

            // Mood tick
            this.mood?.update();

            // Track idle time for mood
            if (this.taskQueue.isIdle()) {
                if (this.idleStartTime === 0) this.idleStartTime = Date.now();
                if (Date.now() - this.idleStartTime > 60000) {
                    this.mood?.onEvent('idle_long');
                    this.idleStartTime = Date.now(); // reset so it only fires periodically
                }
            } else {
                this.idleStartTime = 0;
            }

            // Mode controller
            if (this.modes) {
                await this.modes.update();
            }

            // Task queue
            await this.taskQueue.executeNext();
        }, INTERVAL));

        // Status logging
        this.intervals.push(setInterval(() => {
            if (!this.bot?.entity) return;
            const pos = this.bot.entity.position;
            if (Number.isNaN(pos.x) || Number.isNaN(pos.y) || Number.isNaN(pos.z)) {
                this.log('[CRITICAL] Position NaN, reconnecting...');
                this.bot.quit();
                return;
            }
            const stats = this.evolution.getStats();
            this.log(`Status: HP=${this.bot.health} Food=${this.bot.food} Pos=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) Skills=${stats.skills}`);
        }, this.config.bot.statusInterval));

        // Dashboard tick
        this.intervals.push(setInterval(() => {
            if (this.dashboard) this.dashboard.tick();
        }, 1000));

        // Evolution reflection
        this.intervals.push(setInterval(async () => {
            if (this.evolution && this.config.evolution.enabled) {
                this.log('[Evolve] Reflecting...');
                await this.evolution.reflect(this.openai, this.config.ai.model);
            }
        }, this.config.bot.reflectionInterval));
    }

    getTaskHandlers() {
        const self = this;
        const bot = this.bot;
        return {
            collect: async (params) => {
                const count = params.count || 5;
                const collected = await self.skills.gather.collectBlock(params.target, 30, count);
                self.evolution.recordExperience('collect', params.target, collected > 0, `Collected ${collected}/${count}`);
                return { result: collected > 0, detail: `Collected ${collected}/${count} ${params.target}` };
            },
            follow: async (params) => {
                const player = bot.players[params.username]?.entity;
                if (!player) return { result: false, detail: `Player ${params.username} not found` };
                await self.skills.movement.follow(player, 3, 30000);
                self.evolution.recordExperience('follow', params.username, true, 'Followed');
                return { result: true, detail: `Followed ${params.username}` };
            },
            attack: async () => {
                const world = require('../utils/world');
                let enemy = world.getNearestEntityWhere(bot, e => world.isHostile(e), 8);
                if (!enemy) enemy = world.getNearestEntityWhere(bot, e => world.isHuntable(e), 12);
                if (!enemy) return { result: false, detail: 'No target' };
                const ok = await self.skills.combat.attackEntity(enemy);
                self.evolution.recordExperience('attack', enemy.name, ok, 'Attacked target');
                return { result: ok, detail: `Attacked ${enemy.name}` };
            },
            farm: async () => {
                const harvested = await self.skills.farming.harvestCrops();
                self.evolution.recordExperience('farm', 'crops', harvested > 0, `Harvested ${harvested}`);
                return { result: harvested > 0, detail: `Harvested ${harvested} crops` };
            },
            build: async () => {
                const pos = bot.entity.position;
                const placed = await self.skills.building.buildShelter(pos);
                self.evolution.recordExperience('build', 'shelter', placed > 0, `Placed ${placed} blocks`);
                return { result: placed > 0, detail: `Placed ${placed} blocks` };
            },
            deposit: async (params) => {
                const ok = await self.skills.storage.deposit(params.items || []);
                self.evolution.recordExperience('deposit', 'chest', ok, 'Deposited items');
                return { result: ok, detail: 'Deposited items' };
            },
            withdraw: async (params) => {
                const ok = await self.skills.storage.withdraw(params.item, params.count || 1);
                return { result: ok, detail: `Withdrew ${params.count || 1} ${params.item}` };
            },
            stop: async () => {
                self.taskQueue.clear();
                bot.pathfinder.stop();
                bot.clearControlStates();
                return { result: true, detail: 'Stopped' };
            },
            use_skill: async (params) => {
                const ok = await self.skillRegistry.execute(params.name, params.steps);
                return { result: ok, detail: `Executed skill ${params.name}` };
            },
        };
    }

    async executeTask(task) {
        const handlers = this.getTaskHandlers();
        const handler = handlers[task.type];
        if (!handler) {
            // Try dynamic skill
            if (this.skillRegistry?.has(task.type)) {
                const ok = await this.skillRegistry.execute(task.type);
                if (ok) this.mood?.onEvent('completed_task', { type: task.type, detail: `Skill ${task.type}` });
                return ok;
            }
            this.log(`[Task] Unknown task type: ${task.type}`);
            return false;
        }

        try {
            const { result, detail } = await handler(task.params);
            if (result) {
                this.mood?.onEvent('completed_task', { type: task.type, detail });
            }
            return result;
        } catch (e) {
            this.log(`[Task] ${task.type} error:`, e.message);
            return false;
        }
    }

    handleConsoleCommand(input) {
        const [cmd, ...args] = input.trim().split(/\s+/);
        const rest = args.join(' ');
        switch (cmd) {
            case 'say':
                if (this.bot?.chat) this.bot.chat(rest);
                break;
            case 'follow':
                this.taskQueue.add('follow', { username: args[0] || 'Jacky_MC_' }, { priority: 7, source: 'console' });
                break;
            case 'collect':
                this.taskQueue.add('collect', { target: args[0] || 'log', count: parseInt(args[1]) || 5 }, { priority: 6, source: 'console' });
                break;
            case 'attack':
                this.taskQueue.add('attack', {}, { priority: 9, source: 'console' });
                break;
            case 'farm':
                this.taskQueue.add('farm', {}, { priority: 6, source: 'console' });
                break;
            case 'build':
                this.taskQueue.add('build', {}, { priority: 5, source: 'console' });
                break;
            case 'deposit':
                this.taskQueue.add('deposit', { items: args.length ? args : ['cobblestone', 'dirt'] }, { priority: 6, source: 'console' });
                break;
            case 'stop':
                this.taskQueue.clear();
                this.bot?.pathfinder?.stop();
                this.bot?.clearControlStates();
                this.log('Stopped.');
                break;
            case 'status':
                this.log(this.dashboard?.getStatus() || 'No status');
                break;
            case 'model':
                if (args.length > 0) {
                    this.setModel(args[0]);
                } else {
                    this.log(`Current model: ${this.config.ai.model}`);
                    this.log(`Base URL: ${this.config.ai.baseURL}`);
                }
                break;
            case 'mood':
                this.log(this.mood ? JSON.stringify(this.mood.getStatus(), null, 2) : 'No mood system');
                break;
            case 'idle':
                if (args[0] === 'off') {
                    this.config.bot.idleGoalsEnabled = false;
                    this.log('Idle goals disabled.');
                } else if (args[0] === 'on') {
                    this.config.bot.idleGoalsEnabled = true;
                    this.log('Idle goals enabled.');
                } else {
                    this.log(`Idle goals: ${this.config.bot.idleGoalsEnabled !== false ? 'enabled' : 'disabled'}`);
                }
                break;
            case 'quit':
                this.bot?.quit();
                process.exit(0);
                break;
            default:
                this.log('Commands: say <msg>, follow <player>, collect <block> [count], attack, farm, build, deposit [items...], stop, status, model [name], mood, idle [on|off], quit');
        }
    }

    setModel(modelId) {
        this.config.ai.model = modelId;
        // Re-create OpenAI client with new config
        this.openai = new OpenAI({
            apiKey: this.config.ai.apiKey,
            baseURL: this.config.ai.baseURL,
        });
        // Also update chatBrain's reference
        if (this.chatBrain) {
            this.chatBrain.openai = this.openai;
        }
        this.log(`[Config] Switched to model: ${modelId}`);
        try {
            const { saveConfig } = require('./Config');
            saveConfig(this.config);
        } catch (e) {}
        return modelId;
    }
}

module.exports = Agent;

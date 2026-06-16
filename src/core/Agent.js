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
        defaultMove.canDig = true;
        defaultMove.digCost = 1;
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
        this.skills.combat.loadPlugin();
        this.skills.survival = new SurvivalSkill(this);
        this.skills.survival.loadPlugin();
        this.skills.inventory = new InventorySkill(this);
        this.skills.gather = new GatherSkill(this);
        this.skills.farming = new FarmingSkill(this);
        this.skills.building = new BuildingSkill(this);
        this.skills.storage = new StorageSkill(this);

        // Initialize core systems
        this.taskQueue = new TaskQueue(this);
        this.modes = new ModeController(this);
        this.evolution = new EvolutionSystem(this.bot.username, this.log);
        this.chatBrain = new ChatBrain(this);
        this.dashboard = new Dashboard(this);
        this.dashboard.start();

        this.setupEvents();
        this.startUpdateLoop();

        const stats = this.evolution.getStats();
        this.log(`[Evolve] Loaded ${stats.skills} skills, ${stats.experiences} experiences`);
        this.log('Agent ready!');
    }

    setupEvents() {
        let prevHealth = this.bot.health;
        this.bot.on('health', () => {
            if (this.bot.health < prevHealth) {
                this.lastDamageTime = Date.now();
            }
            prevHealth = this.bot.health;
        });

        const handleChat = async (username, message) => {
            if (username === this.bot.username) return;
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
        });
    }

    startUpdateLoop() {
        const INTERVAL = this.config.bot.updateInterval;

        this.intervals.push(setInterval(async () => {
            if (!this.bot?.entity) return;

            // Survival check
            await this.skills.survival.eatIfNeeded();
            await this.skills.survival.healIfCritical();
            this.skills.combat.equipArmor();

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

    async executeTask(task) {
        const bot = this.bot;
        switch (task.type) {
            case 'collect': {
                const count = task.params.count || 5;
                const collected = await this.skills.gather.collectBlock(task.params.target, 30, count);
                this.evolution.recordExperience('collect', task.params.target, collected > 0, `Collected ${collected}/${count}`);
                return collected > 0;
            }
            case 'follow': {
                const player = bot.players[task.params.username]?.entity;
                if (!player) return false;
                await this.skills.movement.follow(player, 3, 5000);
                this.evolution.recordExperience('follow', task.params.username, true, 'Followed');
                return true;
            }
            case 'attack': {
                const enemy = require('../utils/world').getNearestEntityWhere(bot, e => require('../utils/world').isHostile(e), 8);
                if (!enemy) return false;
                const ok = await this.skills.combat.attackEntity(enemy);
                this.evolution.recordExperience('attack', enemy.name, ok, 'Attacked hostile');
                return ok;
            }
            case 'farm': {
                const harvested = await this.skills.farming.harvestCrops();
                this.evolution.recordExperience('farm', 'crops', harvested > 0, `Harvested ${harvested}`);
                return harvested > 0;
            }
            case 'build': {
                const pos = bot.entity.position;
                const placed = await this.skills.building.buildShelter(pos);
                this.evolution.recordExperience('build', 'shelter', placed > 0, `Placed ${placed} blocks`);
                return placed > 0;
            }
            case 'deposit': {
                const ok = await this.skills.storage.deposit(task.params.items || []);
                this.evolution.recordExperience('deposit', 'chest', ok, 'Deposited items');
                return ok;
            }
            case 'withdraw': {
                const ok = await this.skills.storage.withdraw(task.params.item, task.params.count || 1);
                return ok;
            }
            case 'stop': {
                this.taskQueue.clear();
                bot.pathfinder.stop();
                bot.clearControlStates();
                return true;
            }
            default:
                this.log(`[Task] Unknown task type: ${task.type}`);
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
            case 'quit':
                this.bot?.quit();
                process.exit(0);
                break;
            default:
                this.log('Commands: say <msg>, follow <player>, collect <block> [count], attack, farm, build, deposit [items...], stop, status, quit');
        }
    }
}

module.exports = Agent;

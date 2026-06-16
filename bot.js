/**
 * MC Agent v2 - Inspired by Mindcraft
 * 核心改进：
 * - 模式系统（Modes）处理不同情况
 * - moveAway 脱离卡住，而不是 dig
 * - 300ms 更新循环
 * - 动作可中断
 */

const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const Movements = require('mineflayer-pathfinder').Movements;
const { GoalNear, GoalInvert, GoalFollow } = require('mineflayer-pathfinder').goals;
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const CONFIG = {
    minecraft: {
        host: '127.0.0.1',
        port: 25565,
        username: 'EvoBot',
        version: '1.20.1',
        password: '',
    },
    ai: {
        apiKey: 'sk-ad0838772f58402fb66087b7d8af153e',
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
    },
};

// ============ 日志 ============
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}
const logFileName = `bot_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`;
const logFilePath = path.join(logsDir, logFileName);

function log(...args) {
    const line = `[${new Date().toLocaleTimeString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
    console.log(line);
    try {
        fs.appendFileSync(logFilePath, line + '\n');
    } catch (e) {
        // ignore log write errors
    }
}

// ============ 技能库（简化版 Mindcraft skills） ============
const skills = {
    async moveAway(bot, distance) {
        const pos = bot.entity.position;
        const dx = (Math.random() - 0.5) * distance * 2;
        const dz = (Math.random() - 0.5) * distance * 2;
        const goal = new GoalNear(pos.x + dx, pos.y, pos.z + dz, 1);
        try {
            await Promise.race([
                bot.pathfinder.goto(goal),
                new Promise((_, reject) => setTimeout(() => reject(new Error('move timeout')), 5000))
            ]);
            return true;
        } catch (e) {
            bot.pathfinder.stop();
            return false;
        }
    },

    async moveAwayFromEntity(bot, entity, distance) {
        const pos = bot.entity.position;
        const epos = entity.position;
        const dx = pos.x - epos.x;
        const dz = pos.z - epos.z;
        const len = Math.sqrt(dx*dx + dz*dz) || 1;
        const goal = new GoalNear(
            pos.x + (dx/len) * distance,
            pos.y,
            pos.z + (dz/len) * distance,
            1
        );
        try {
            await Promise.race([
                bot.pathfinder.goto(goal),
                new Promise((_, reject) => setTimeout(() => reject(new Error('move timeout')), 5000))
            ]);
            return true;
        } catch (e) {
            bot.pathfinder.stop();
            return false;
        }
    },

    async avoidEnemies(bot, distance) {
        const enemy = bot.nearestEntity(e => e.type === 'mob');
        if (enemy) {
            return await skills.moveAwayFromEntity(bot, enemy, distance);
        }
        return false;
    },

    async defendSelf(bot, range) {
        const enemy = bot.nearestEntity(e => 
            e.type === 'mob' && 
            e.position.distanceTo(bot.entity.position) < range
        );
        if (!enemy) return false;
        try {
            if (bot.entity.position.distanceTo(enemy.position) > 2.5) {
                await Promise.race([
                    bot.pathfinder.goto(new GoalNear(enemy.position.x, enemy.position.y, enemy.position.z, 2)),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('defend timeout')), 3000))
                ]);
            }
            bot.lookAt(enemy.position.offset(0, enemy.height * 0.5, 0));
            bot.attack(enemy);
            return true;
        } catch (e) {
            bot.pathfinder.stop();
            return false;
        }
    },

    async attackEntity(bot, entity) {
        if (!entity) return false;
        try {
            await Promise.race([
                bot.pathfinder.goto(new GoalNear(entity.position.x, entity.position.y, entity.position.z, 2)),
                new Promise((_, reject) => setTimeout(() => reject(new Error('attack timeout')), 5000))
            ]);
            bot.attack(entity);
            return true;
        } catch (e) {
            bot.pathfinder.stop();
            return false;
        }
    },

    async pickupNearbyItems(bot) {
        const item = bot.nearestEntity(e => e.name === 'item');
        if (item) {
            try {
                await bot.pathfinder.goto(new GoalNear(item.position.x, item.position.y, item.position.z, 1));
                return true;
            } catch (e) {
                return false;
            }
        }
        return false;
    },

    async placeBlock(bot, blockType, x, y, z) {
        // 简化版，实际需要更复杂的实现
        return false;
    },

    async safeDig(bot, block) {
        if (!block) return false;
        let current = block;
        for (let i = 0; i < 3; i++) {
            try {
                await bot.dig(current);
                const check = bot.blockAt(current.position);
                if (!check || check.name !== block.name) return true;
                current = check;
                log(`[Dig] Retry ${i + 1}...`);
            } catch (e) {
                await new Promise(r => setTimeout(r, 200));
            }
        }
        return false;
    },

    async harvestTree(bot, startBlock) {
        // BFS 找所有相连的木头（树干）
        const visited = new Set();
        const toVisit = [startBlock.position];
        const logs = [];
        const maxDist = 12;

        while (toVisit.length > 0) {
            const pos = toVisit.shift();
            const key = `${pos.x},${pos.y},${pos.z}`;
            if (visited.has(key)) continue;
            visited.add(key);

            const block = bot.blockAt(pos);
            if (block && block.name && (block.name.includes('log') || block.name.includes('wood') || block.name.includes('stem') || block.name.includes('hyphae'))) {
                logs.push(block);
                // 26 邻域搜索（上下左右前后 + 对角）
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            if (dx === 0 && dy === 0 && dz === 0) continue;
                            const neighbor = pos.offset(dx, dy, dz);
                            if (startBlock.position.distanceTo(neighbor) < maxDist) {
                                toVisit.push(neighbor);
                            }
                        }
                    }
                }
            }
        }

        if (logs.length === 0) return false;

        // 按高度从低到高排序，从底部开始挖，避免爬到树顶被树叶困住
        logs.sort((a, b) => a.position.y - b.position.y);

        log(`[Harvest] Found tree with ${logs.length} logs`);
        let dugCount = 0;
        for (const log of logs) {
            try {
                await Promise.race([
                    bot.pathfinder.goto(new GoalNear(log.position.x, log.position.y, log.position.z, 1)),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('harvest goto timeout')), 8000))
                ]);
                const ok = await skills.safeDig(bot, log);
                if (ok) dugCount++;
            } catch (e) {
                bot.pathfinder.stop();
            }
        }
        log(`[Harvest] Dug ${dugCount}/${logs.length} logs`);
        return dugCount > 0;
    }
};

// ============ 世界查询工具 ============
const world = {
    getNearestEntityWhere(bot, predicate, maxDistance) {
        let nearest = null;
        let minDist = maxDistance;
        for (const entity of Object.values(bot.entities)) {
            if (entity === bot.entity) continue;
            if (!entity.position) continue;
            const dist = entity.position.distanceTo(bot.entity.position);
            if (dist < minDist && predicate(entity)) {
                minDist = dist;
                nearest = entity;
            }
        }
        return nearest;
    },

    getNearestBlock(bot, blockName, maxDistance) {
        const pos = bot.entity.position;
        for (let dx = -maxDistance; dx <= maxDistance; dx++) {
            for (let dy = -maxDistance; dy <= maxDistance; dy++) {
                for (let dz = -maxDistance; dz <= maxDistance; dz++) {
                    const block = bot.blockAt(pos.offset(dx, dy, dz));
                    if (block && block.name.includes(blockName)) {
                        return block;
                    }
                }
            }
        }
        return null;
    },

    isHostile(entity) {
        return entity.type === 'mob' && 
            ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'slime']
                .some(name => entity.name?.includes(name));
    },

    isHuntable(entity) {
        return entity.type === 'animal' &&
            ['pig', 'cow', 'chicken', 'sheep', 'rabbit']
                .some(name => entity.name?.includes(name));
    },

    shouldPlaceTorch(bot) {
        const pos = bot.entity.position;
        const block = bot.blockAt(pos);
        return block && block.name !== 'torch' && bot.time.timeOfDay > 12000;
    }
};

// ============ 模式系统（核心改进） ============
class ModeController {
    constructor(agent) {
        this.agent = agent;
        this.behavior_log = '';
        this.modes = [
            this.createSelfPreservationMode(),
            this.createUnstuckMode(),
            this.createCowardiceMode(),
            this.createSelfDefenseMode(),
            this.createHuntingMode(),
            this.createItemCollectingMode(),
            this.createIdleMode(),
        ];
    }

    createSelfPreservationMode() {
        return {
            name: 'self_preservation',
            priority: 100,
            active: false,
            update: async () => {
                const bot = this.agent.bot;
                const block = bot.blockAt(bot.entity.position);
                const blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
                
                // 溺水 - 跳跃
                if (blockAbove?.name === 'water') {
                    bot.setControlState('jump', true);
                    return true;
                }
                
                // 着火 - 逃跑
                if (block?.name === 'lava' || block?.name === 'fire' || 
                    blockAbove?.name === 'lava' || blockAbove?.name === 'fire') {
                    log('On fire! Moving away!');
                    await skills.moveAway(bot, 5);
                    return true;
                }
                
                // 低血量 - 逃跑
                if (Date.now() - bot.lastDamageTime < 3000 && bot.health < 5) {
                    log('Dying! Running away!');
                    await skills.moveAway(bot, 20);
                    return true;
                }
                
                bot.setControlState('jump', false);
                return false;
            }
        };
    }

    createUnstuckMode() {
        return {
            name: 'unstuck',
            priority: 90,
            active: false,
            prevLocation: null,
            stuckTime: 0,
            lastTime: Date.now(),
            maxStuckTime: 15,
            
            update: async () => {
                const bot = this.agent.bot;
                const pos = bot.entity.position;
                
                // 如果 bot 正在执行任务，卡住阈值放宽到 30 秒；空闲时 15 秒
                const threshold = this.agent.executing ? 30 : this.maxStuckTime;
                if (this.prevLocation && 
                    this.prevLocation.distanceTo(pos) < 0.5) {
                    this.stuckTime += (Date.now() - this.lastTime) / 1000;
                } else {
                    this.prevLocation = pos.clone();
                    this.stuckTime = 0;
                }
                this.lastTime = Date.now();
                
                if (this.stuckTime > threshold) {
                    log('Stuck! Breaking blocks...');
                    this.stuckTime = 0;
                    bot.clearControlStates();
                    bot.pathfinder.stop();
                    
                    // 尝试破坏面前的方块
                    const pos = bot.entity.position;
                    const directions = [
                        { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
                        { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
                        { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }
                    ];
                    
                    for (const dir of directions) {
                        const block = bot.blockAt(pos.offset(dir.x, dir.y, dir.z));
                        if (block && (block.name.includes('leaves') || block.name.includes('log') || block.name === 'grass')) {
                            log(`Breaking ${block.name}...`);
                            try {
                                bot.lookAt(block.position);
                                await skills.safeDig(bot, block);
                            } catch (e) {}
                        }
                    }
                    
                    // 尝试跳跃脱困
                    bot.setControlState('jump', true);
                    await new Promise(r => setTimeout(r, 500));
                    bot.setControlState('jump', false);
                    
                    // 尝试移动
                    await skills.moveAway(bot, 3);
                    return true;
                }
                return false;
            }
        };
    }

    createCowardiceMode() {
        return {
            name: 'cowardice',
            priority: 80,
            active: false,
            update: async () => {
                const enemy = world.getNearestEntityWhere(
                    this.agent.bot, 
                    e => world.isHostile(e), 
                    16
                );
                if (enemy) {
                    log(`Aaa! A ${enemy.name}!`);
                    this.agent.executing = true;
                    try {
                        await skills.moveAwayFromEntity(this.agent.bot, enemy, 24);
                    } catch (e) {}
                    this.agent.executing = false;
                    return true;
                }
                return false;
            }
        };
    }

    createSelfDefenseMode() {
        return {
            name: 'self_defense',
            priority: 70,
            active: false,
            update: async () => {
                const enemy = world.getNearestEntityWhere(
                    this.agent.bot,
                    e => world.isHostile(e),
                    8
                );
                if (enemy) {
                    log(`Fighting ${enemy.name}!`);
                    this.agent.executing = true;
                    try {
                        await skills.defendSelf(this.agent.bot, 8);
                    } catch (e) {}
                    this.agent.executing = false;
                    return true;
                }
                return false;
            }
        };
    }

    createHuntingMode() {
        return {
            name: 'hunting',
            priority: 30,
            active: false,
            update: async () => {
                if (!this.agent.isIdle()) return false;
                const huntable = world.getNearestEntityWhere(
                    this.agent.bot,
                    e => world.isHuntable(e),
                    8
                );
                if (huntable) {
                    log(`Hunting ${huntable.name}!`);
                    this.agent.executing = true;
                    try {
                        await skills.attackEntity(this.agent.bot, huntable);
                    } catch (e) {}
                    this.agent.executing = false;
                    return true;
                }
                return false;
            }
        };
    }

    createItemCollectingMode() {
        return {
            name: 'item_collecting',
            priority: 20,
            active: false,
            update: async () => {
                if (!this.agent.isIdle()) return false;
                const item = world.getNearestEntityWhere(
                    this.agent.bot,
                    e => e.name === 'item',
                    8
                );
                if (item && this.agent.bot.inventory.emptySlotCount() > 1) {
                    log('Picking up item!');
                    this.agent.executing = true;
                    try {
                        await skills.pickupNearbyItems(this.agent.bot);
                    } catch (e) {}
                    this.agent.executing = false;
                    return true;
                }
                return false;
            }
        };
    }

    createIdleMode() {
        return {
            name: 'idle',
            priority: 0,
            active: false,
            update: async () => {
                if (!this.agent.isIdle()) return false;
                
                const bot = this.agent.bot;
                const pos = bot.entity.position;
                
                // 1. 如果有目标，执行目标
                if (this.agent.currentGoal) {
                    return await this.executeGoal();
                }
                
                // 2. 检查附近有可采集资源
                const collectables = ['log', 'oak_log', 'birch_log', 'stone', 'coal_ore', 'iron_ore'];
                for (const name of collectables) {
                    const block = world.getNearestBlock(bot, name, 10);
                    if (block) {
                        log(`Found ${block.name}, collecting...`);
                        this.agent.executing = true;
                        let success = false;
                        try {
                            // 如果是木头，用 harvestTree 把整棵树砍干净
                            if (block.name.includes('log') || block.name.includes('wood') || block.name.includes('stem') || block.name.includes('hyphae')) {
                                success = await skills.harvestTree(bot, block);
                            } else {
                                await bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 1));
                                success = await skills.safeDig(bot, block);
                            }
                            if (success) log(`Collected ${block.name}`);
                        } catch (e) {}
                        this.agent.executing = false;
                        return success;
                    }
                }
                
                // 3. 跟随最近的玩家
                const player = world.getNearestEntityWhere(bot, e => e.type === 'player' && e.name !== bot.username, 20);
                if (player && player.position.distanceTo(pos) > 5) {
                    log(`Following ${player.name}...`);
                    this.agent.executing = true;
                    try {
                        await bot.pathfinder.goto(new GoalNear(player.position.x, player.position.y, player.position.z, 3));
                    } catch (e) {}
                    this.agent.executing = false;
                    return true;
                }
                
                return false;
            }
        };
    }
    
    async executeGoal() {
        const bot = this.agent.bot;
        const goal = this.agent.currentGoal;
        
        if (goal.type === 'collect') {
            const block = world.getNearestBlock(bot, goal.target, 30);
            if (block) {
                log(`Going to collect ${goal.target}...`);
                this.agent.executing = true;
                let success = false;
                try {
                    // 如果是木头类，砍整棵树
                    if (block.name.includes('log') || block.name.includes('wood') || block.name.includes('stem') || block.name.includes('hyphae')) {
                        success = await skills.harvestTree(bot, block);
                    } else {
                        await bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 1));
                        success = await skills.safeDig(bot, block);
                    }
                    if (success) {
                        log(`Collected ${goal.target}`);
                        goal.count = (goal.count || 0) + 1;
                        if (goal.count >= (goal.targetCount || 1)) {
                            this.agent.currentGoal = null;
                        }
                    } else {
                        log(`Failed to collect ${goal.target}`);
                    }
                } catch (e) {
                    log(`Failed to collect ${goal.target}`);
                }
                this.agent.executing = false;
                this.agent.evolution.recordExperience('collect', goal.target, success, `Found at (${block.position.x.toFixed(0)}, ${block.position.y.toFixed(0)}, ${block.position.z.toFixed(0)})`);
                return true;
            } else {
                log(`No ${goal.target} found nearby`);
                this.agent.evolution.recordExperience('collect', goal.target, false, 'Not found in range');
                this.agent.currentGoal = null;
            }
        } else if (goal.type === 'follow') {
            const player = bot.players[goal.target]?.entity;
            if (player) {
                this.agent.executing = true;
                let success = false;
                try {
                    await bot.pathfinder.goto(new GoalNear(player.position.x, player.position.y, player.position.z, 3));
                    success = true;
                } catch (e) {}
                this.agent.executing = false;
                this.agent.evolution.recordExperience('follow', goal.target, success, `Distance: ${player.position.distanceTo(bot.entity.position).toFixed(1)}`);
                return true;
            }
        }
        
        return false;
    }

    async update() {
        for (const mode of this.modes) {
            if (mode.active) continue;
            try {
                const triggered = await mode.update();
                if (triggered) {
                    mode.active = true;
                    setTimeout(() => { mode.active = false; }, 1000);
                    break; // 一次只触发一个模式
                }
            } catch (e) {
                // 忽略模式错误
            }
        }
    }
}

// ============ Agent 主类 ============
// ============ 进化系统 ============
class EvolutionSystem {
    constructor(botName) {
        this.botName = botName;
        this.dataDir = path.join(__dirname, 'evolution');
        this.skillsFile = path.join(this.dataDir, `${botName}_skills.json`);
        this.experiencesFile = path.join(this.dataDir, `${botName}_experiences.json`);
        this.skills = this.loadSkills();
        this.experiences = this.loadExperiences();
    }

    loadSkills() {
        try {
            if (fs.existsSync(this.skillsFile)) {
                return JSON.parse(fs.readFileSync(this.skillsFile, 'utf8'));
            }
        } catch (e) {}
        return [];
    }

    loadExperiences() {
        try {
            if (fs.existsSync(this.experiencesFile)) {
                return JSON.parse(fs.readFileSync(this.experiencesFile, 'utf8'));
            }
        } catch (e) {}
        return [];
    }

    save() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
        fs.writeFileSync(this.skillsFile, JSON.stringify(this.skills, null, 2));
        fs.writeFileSync(this.experiencesFile, JSON.stringify(this.experiences, null, 2));
    }

    recordExperience(action, target, success, details) {
        const exp = {
            id: Date.now(),
            action,
            target,
            success,
            details,
            timestamp: new Date().toISOString(),
        };
        this.experiences.push(exp);
        if (this.experiences.length > 100) this.experiences.shift();
        
        // 更新或创建技能
        this.updateSkill(action, target, success);
        this.save();
    }

    updateSkill(action, target, success) {
        let skill = this.skills.find(s => s.action === action && s.target === target);
        if (!skill) {
            skill = {
                id: `skill_${Date.now()}`,
                action,
                target,
                uses: 0,
                successes: 0,
                created: new Date().toISOString(),
            };
            this.skills.push(skill);
            log(`[Evolve] New skill learned: ${action} -> ${target}`);
        }
        skill.uses++;
        if (success) skill.successes++;
        skill.lastUsed = new Date().toISOString();
        skill.rate = (skill.successes / skill.uses * 100).toFixed(1);
    }

    getBestSkill(action) {
        const relevant = this.skills.filter(s => s.action === action);
        if (relevant.length === 0) return null;
        return relevant.sort((a, b) => (b.successes / b.uses) - (a.successes / a.uses))[0];
    }

    getStats() {
        return {
            skills: this.skills.length,
            experiences: this.experiences.length,
            topSkill: this.skills.length > 0 ? 
                this.skills.sort((a, b) => (b.successes / b.uses) - (a.successes / a.uses))[0] : null,
        };
    }

    async reflect(openai, model) {
        if (this.experiences.length < 5) return;
        
        const recent = this.experiences.slice(-10);
        const successes = recent.filter(e => e.success).length;
        const failures = recent.length - successes;
        
        const prompt = `Review these recent experiences:
${recent.map(e => `- ${e.action} ${e.target}: ${e.success ? 'success' : 'failure'} - ${e.details}`).join('\n')}

Successes: ${successes}, Failures: ${failures}

Generate ONE new strategy or tip for future actions. Keep it under 50 words.`;

        try {
            const response = await openai.chat.completions.create({
                model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 100,
            });
            const insight = response.choices?.[0]?.message?.content?.trim();
            if (insight) {
                log(`[Evolve] Reflection: ${insight.substring(0, 100)}`);
                this.experiences.push({
                    id: Date.now(),
                    action: 'reflection',
                    target: 'self',
                    success: true,
                    details: insight,
                    timestamp: new Date().toISOString(),
                });
                this.save();
            }
        } catch (e) {}
    }
}

// ============ Agent 主类 ============
class Agent {
    constructor() {
        this.bot = null;
        this.openai = new OpenAI({
            apiKey: CONFIG.ai.apiKey,
            baseURL: CONFIG.ai.baseURL,
        });
        this.modes = null;
        this.executing = false;
        this.lastDamageTime = 0;
        this.conversationHistory = this.loadMemory();
        this.evolution = null;
        this.currentGoal = null;
        this.intervals = [];
        this.memoryDir = path.join(__dirname, 'memories');
        if (!fs.existsSync(this.memoryDir)) {
            fs.mkdirSync(this.memoryDir, { recursive: true });
        }
    }

    loadMemory() {
        try {
            const file = path.join(__dirname, 'memories', 'current_conversation.json');
            if (fs.existsSync(file)) {
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            }
        } catch (e) {}
        return [];
    }

    saveMemory() {
        try {
            const file = path.join(this.memoryDir, 'current_conversation.json');
            fs.writeFileSync(file, JSON.stringify(this.conversationHistory.slice(-40), null, 2));
        } catch (e) {}
    }

    archiveConversation(systemPrompt) {
        if (this.conversationHistory.length < 2) return;
        try {
            const file = path.join(this.memoryDir, 'training_data.jsonl');
            const messages = [
                { role: 'system', content: systemPrompt },
                ...this.conversationHistory.map(h => ({
                    role: h.role,
                    content: h.name && h.role === 'user' ? `${h.name}: ${h.content}` : h.content
                }))
            ];
            const line = JSON.stringify({ messages }) + '\n';
            fs.appendFileSync(file, line);
        } catch (e) {}
    }

    isIdle() {
        return !this.executing;
    }

    async start() {
        // 清理旧定时器
        if (this.intervals?.length > 0) {
            this.intervals.forEach(id => clearInterval(id));
            this.intervals = [];
        }
        // 清理旧 bot，避免重复监听和连接
        if (this.bot) {
            try {
                this.bot.removeAllListeners();
                this.bot.quit();
            } catch (e) {}
            this.bot = null;
        }

        this.bot = mineflayer.createBot(CONFIG.minecraft);
        this.bot.loadPlugin(pathfinder);

        this.bot.on('login', () => {
            log('Logged in!');
        });

        this.bot.once('spawn', async () => {
            log('Spawned!');
            // 测试 bot.chat 是否有效
            setTimeout(() => {
                if (this.bot && this.bot.chat) {
                    log('[Test] Sending spawn test message...');
                    this.bot.chat('Bot is online and ready!');
                }
            }, 2000);
            
            // 初始化 pathfinder
            const mcData = require('minecraft-data')(this.bot.version);
            const defaultMove = new Movements(this.bot, mcData);
            
            // 允许通过树叶和破坏阻挡方块
            defaultMove.canDig = true;
            defaultMove.digCost = 1;
            defaultMove.placeCost = 1;
            
            // 允许在树叶上走
            const originalSafe = defaultMove.safeToBreak;
            defaultMove.safeToBreak = (block) => {
                if (block.name.includes('leaves') || block.name.includes('log')) return true;
                return originalSafe.call(defaultMove, block);
            };
            
            this.bot.pathfinder.setMovements(defaultMove);
            
            // 初始化模式系统
            this.modes = new ModeController(this);
            
            // 初始化进化系统
            this.evolution = new EvolutionSystem(this.bot.username);
            const stats = this.evolution.getStats();
            log(`[Evolve] Loaded ${stats.skills} skills, ${stats.experiences} experiences`);
            if (stats.topSkill) {
                log(`[Evolve] Best skill: ${stats.topSkill.action} -> ${stats.topSkill.target} (${stats.topSkill.rate}%)`);
            }
            
            // 设置事件监听
            this.setupEvents();
            
            // 启动更新循环（每 300ms，像 Mindcraft 一样）
            this.startUpdateLoop();
            
            log('Agent ready!');
        });

        this.bot.on('error', (err) => {
            log('Error:', err.message);
        });

        this.bot.on('end', () => {
            log('Disconnected. Reconnecting in 5s...');
            setTimeout(() => this.start(), 5000);
        });
    }

    setupEvents() {
        // 健康监测
        let prevHealth = this.bot.health;
        this.bot.on('health', () => {
            if (this.bot.health < prevHealth) {
                this.lastDamageTime = Date.now();
            }
            prevHealth = this.bot.health;
        });

        // 原始消息监听（用于调试非标准聊天格式 + 备用解析）
        this.bot.on('message', (jsonMsg, position) => {
            const text = jsonMsg.toString();
            // 忽略动作栏消息
            if (position !== 'chat' && position !== 'system') return;
            
            log(`[RawMsg] pos=${position} text=${text.substring(0, 120)}`);
            
            // 备用：如果 chat 事件没触发，尝试自己解析玩家消息
            // 常见格式：<Player> message 或 [Prefix] Player: message 或 Player » message
            const chatPatterns = [
                /^<([^>]+)>\s*(.+)$/,           // <Player> msg
                /^\[.*?\]\s*(\S+)[：:]\s*(.+)$/, // [Prefix] Player: msg
                /^(\S+)\s*[»››]+\s*(.+)$/,      // Player » msg
                /^(\S+)\s+说[：:]\s*(.+)$/,      // Player 说: msg
            ];
            
            for (const pattern of chatPatterns) {
                const match = text.match(pattern);
                if (match) {
                    const extractedUser = match[1].trim();
                    const extractedMsg = match[2].trim();
                    if (extractedUser !== this.bot.username) {
                        log(`[RawMsg] Fallback parsed: ${extractedUser}: ${extractedMsg}`);
                        // 不直接调用 handleMessage 避免重复处理，仅当 chat 事件确实没捕获时
                        // 实际上我们这里不主动调用，因为可能重复。主要是看日志。
                    }
                    break;
                }
            }
        });

        // 聊天处理
        const handleMessage = async (username, message) => {
            log(`[ChatEvent] FIRED! username=${username}, message=${message}`);
            if (username === this.bot.username) {
                log('[ChatEvent] Ignored: self message');
                return;
            }
            log(`[Chat] <${username}> ${message}`);
            
            // 解析命令
            const command = this.parseCommand(message);
            if (command) {
                log(`[Chat] Parsed command: ${JSON.stringify(command)}`);
                try {
                    this.handleCommand(username, command);
                } catch (e) {
                    log('[Chat] Command error:', e.message);
                    this.bot.chat('Command error: ' + e.message);
                }
                return;
            }
            
            // AI 回复
            log(`[Chat] No command match, sending to AI...`);
            try {
                await this.handleChat(username, message);
            } catch (e) {
                log('[Chat] Error:', e.message);
                try { this.bot.chat('Hmm, my brain is lagging...'); } catch (err) {}
            }
        };
        
        this.bot.on('chat', handleMessage);
        this.bot.on('whisper', handleMessage);
        log('[Events] Chat and whisper listeners attached');

        // 死亡处理
        this.bot.on('death', () => {
            log('Died! Respawning...');
            this.executing = false;
            this.currentGoal = null;
            this.bot.pathfinder.stop();
            this.bot.clearControlStates();
        });
    }

    parseCommand(message) {
        const lower = message.toLowerCase();
        
        // 收集命令
        if (lower.includes('挖') || lower.includes('采集') || lower.includes('collect') || lower.includes('get')) {
            const targets = ['木头', 'wood', 'log', '石头', 'stone', '煤', 'coal', '铁', 'iron'];
            for (const target of targets) {
                if (lower.includes(target)) {
                    const map = {
                        '木头': 'log', 'wood': 'log', 'log': 'log',
                        '石头': 'stone', 'stone': 'stone',
                        '煤': 'coal_ore', 'coal': 'coal_ore',
                        '铁': 'iron_ore', 'iron': 'iron_ore'
                    };
                    return { type: 'collect', target: map[target] || target, targetCount: 5 };
                }
            }
        }
        
        // 跟随命令
        if (lower.includes('跟随') || lower.includes('follow') || lower.includes('过来')) {
            return { type: 'follow', target: 'Jacky_MC_' };
        }
        
        // 停止命令
        if (lower.includes('停止') || lower.includes('stop') || lower.includes('别动')) {
            return { type: 'stop' };
        }
        
        return null;
    }
    
    handleCommand(username, command) {
        try {
            if (command.type === 'collect') {
                this.currentGoal = command;
                this.bot.chat(`OK, I'll collect ${command.target}!`);
                log(`[Goal] Collect ${command.target} x${command.targetCount}`);
            } else if (command.type === 'follow') {
                this.currentGoal = command;
                this.bot.chat(`Following you, ${username}!`);
                log(`[Goal] Follow ${username}`);
            } else if (command.type === 'stop') {
                this.currentGoal = null;
                this.bot.pathfinder.stop();
                this.bot.clearControlStates();
                this.executing = false;
                this.bot.chat('Stopped!');
                log('[Goal] Stopped');
            }
        } catch (e) {
            log('[Command] Error executing command:', e.message);
        }
    }
    
    getSurroundings() {
        const bot = this.bot;
        const pos = bot.entity.position;
        const nearby = [];
        for (const entity of Object.values(bot.entities)) {
            if (entity === bot.entity) continue;
            if (!entity.position) continue;
            const dist = entity.position.distanceTo(pos);
            if (dist < 24) {
                const name = entity.username || entity.name || '?';
                const type = entity.type || '?';
                nearby.push(`${name}(${type},${dist.toFixed(0)}m)`);
            }
        }
        const timeOfDay = bot.time?.timeOfDay || 0;
        const goal = this.currentGoal ? `${this.currentGoal.type} ${this.currentGoal.target || ''}` : 'idle';
        return {
            nearby: nearby.slice(0, 6).join(', ') || 'nothing nearby',
            time: timeOfDay < 12000 ? 'day' : 'night',
            goal
        };
    }

    executeAiAction(action, target, sourceUsername) {
        const bot = this.bot;
        switch (action) {
            case 'collect':
                if (target) {
                    this.currentGoal = { type: 'collect', target, targetCount: 5 };
                    log(`[AI Action] Collect ${target}`);
                }
                break;
            case 'follow':
                this.currentGoal = { type: 'follow', target: target || sourceUsername };
                log(`[AI Action] Follow ${target || sourceUsername}`);
                break;
            case 'stop':
                this.currentGoal = null;
                bot.pathfinder.stop();
                bot.clearControlStates();
                this.executing = false;
                log('[AI Action] Stop');
                break;
            case 'attack':
                const enemy = world.getNearestEntityWhere(bot, e => world.isHostile(e), 8);
                if (enemy) {
                    skills.attackEntity(bot, enemy);
                    log(`[AI Action] Attack ${enemy.name}`);
                }
                break;
            case 'pickup':
                skills.pickupNearbyItems(bot);
                log('[AI Action] Pickup items');
                break;
            case 'idle':
                this.currentGoal = null;
                log('[AI Action] Idle');
                break;
            default:
                log(`[AI Action] Unknown: ${action}`);
        }
    }

    async handleChat(username, message) {
        try {
            const pos = this.bot.entity.position;
            const env = this.getSurroundings();

            // 保存到对话历史
            this.conversationHistory.push({ role: 'user', name: username, content: message });
            if (this.conversationHistory.length > 20) {
                this.conversationHistory = this.conversationHistory.slice(-20);
            }

            const systemPrompt = `You are ${this.bot.username}, a self-aware Minecraft bot.
You observe the world, remember conversations, and DECIDE what to do.
You MUST end your reply with [DO:action] or [DO:action:target] when you decide to act.

Available actions:
- [DO:collect:log] / [DO:collect:stone]
- [DO:follow] / [DO:follow:PlayerName]
- [DO:attack]
- [DO:pickup]
- [DO:stop]
- [DO:idle]

CRITICAL RULES:
- If you say you will do something, you MUST end with the matching [DO:...].
  Example: "我去砍木头 [DO:collect:log]"  "跟着你 [DO:follow]"
- No emojis. Plain text only.
- Keep replies under 80 chars.
- Reply in the same language the player uses.`;
            this.lastSystemPrompt = systemPrompt;

            const userPrompt = `Environment:
- Nearby: ${env.nearby}
- Time: ${env.time}
- HP: ${this.bot.health}/20
- Position: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})
- Current task: ${env.goal}

Recent conversation:
${this.conversationHistory.slice(-6).map(h => `${h.name || this.bot.username}: ${h.content}`).join('\n')}

${username} just said: "${message}"

Reply naturally. If you decide to act, end with [DO:action:target].`;

            log('[AI] Thinking...');
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await this.openai.chat.completions.create({
                model: CONFIG.ai.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 120,
                temperature: 0.8,
            }, { signal: controller.signal });

            clearTimeout(timeoutId);

            const reply = response.choices?.[0]?.message?.content?.trim();
            if (reply) {
                // 解析 [DO: action : target] 标记（允许空格）
                const actionMatch = reply.match(/\[DO\s*:\s*([^:\]]+?)\s*(?::\s*([^\]]+?))?\s*\]/);
                let chatMsg = reply;
                if (actionMatch) {
                    const action = actionMatch[1].trim();
                    const target = actionMatch[2] ? actionMatch[2].trim() : '';
                    this.executeAiAction(action, target, username);
                    chatMsg = reply.replace(actionMatch[0], '').trim();
                }

                if (chatMsg) {
                    const cleanReply = chatMsg.substring(0, 120);
                    log(`[AI] ${cleanReply}`);
                    this.bot.chat(cleanReply);
                }
                this.conversationHistory.push({ role: 'assistant', name: this.bot.username, content: reply });
                // 自动存档记忆（Hermes/ShareGPT 格式）
                this.saveMemory();
                if (this.conversationHistory.length >= 6 && this.conversationHistory.length % 6 === 0) {
                    this.archiveConversation(this.lastSystemPrompt);
                }
            } else {
                this.bot.chat('...');
            }
        } catch (e) {
            log('[AI] Error:', e.message || e);
            try { this.bot.chat('脑抽了...'); } catch (err) {}
        }
    }

    startUpdateLoop() {
        const INTERVAL = 300; // 300ms，像 Mindcraft
        
        this.intervals.push(setInterval(async () => {
            if (this.modes) {
                await this.modes.update();
            }
        }, INTERVAL));

        // 状态日志 + NaN 检测（每 10 秒）
        this.intervals.push(setInterval(() => {
            if (this.bot?.entity) {
                const pos = this.bot.entity.position;
                if (Number.isNaN(pos.x) || Number.isNaN(pos.y) || Number.isNaN(pos.z)) {
                    log('[CRITICAL] Position corrupted (NaN), reconnecting...');
                    this.bot.quit(); // 让 'end' 事件处理重连
                    return;
                }
                const stats = this.evolution?.getStats();
                const hp = this.bot.health ?? '?';
                log(`Status: HP=${hp} Pos=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) Skills=${stats?.skills || 0}`);
            }
        }, 10000));
        
        // 定期反思（每 2 分钟）
        this.intervals.push(setInterval(async () => {
            if (this.evolution) {
                log('[Evolve] Reflecting on experiences...');
                await this.evolution.reflect(this.openai, CONFIG.ai.model);
            }
        }, 120000));
    }
}

// ============ 启动 ============
console.log('\n======================================');
console.log('  MC Agent v2 - Mindcraft Inspired');
console.log('======================================\n');

const agent = new Agent();
agent.start();

// 控制台命令
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', (input) => {
    const [cmd, ...args] = input.trim().split(' ');
    
    switch (cmd) {
        case 'say':
            agent.bot?.chat(args.join(' '));
            break;
        case 'quit':
            agent.bot?.quit();
            process.exit(0);
            break;
        default:
            if (cmd) log('Commands: say <msg>, quit');
    }
});

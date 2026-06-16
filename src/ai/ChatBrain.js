const fs = require('fs');
const path = require('path');

// Resource name mappings for Chinese → English
const RESOURCE_MAP = {
    '木头': 'log', '树木': 'log', '树干': 'log', '橡木': 'oak_log', '白桦木': 'birch_log',
    '石头': 'stone', '圆石': 'cobblestone', '石块': 'stone',
    '煤矿': 'coal_ore', '煤': 'coal_ore', '煤炭': 'coal_ore',
    '铁矿': 'iron_ore', '铁': 'iron_ore', '铁矿石': 'iron_ore',
    '金矿': 'gold_ore', '金': 'gold_ore',
    '钻石矿': 'diamond_ore', '钻石': 'diamond_ore',
    '红石': 'redstone_ore', '红石矿': 'redstone_ore',
    '沙子': 'sand', '沙砾': 'gravel', '泥土': 'dirt',
};

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'collect',
            description: `Collect/gather/mine a resource block.
Use when player says: 挖/砍/采集/收集/mine/dig/chop/collect/get + resource name.
Resource mapping: 木头/树→log, 石头→stone, 煤→coal_ore, 铁→iron_ore, 钻石→diamond_ore, 沙子→sand, 泥土→dirt.
Only use for resources listed in the nearby-blocks section of the environment.`,
            parameters: {
                type: 'object',
                properties: {
                    target: {
                        type: 'string',
                        description: 'Block ID to collect: log, stone, cobblestone, coal_ore, iron_ore, gold_ore, diamond_ore, redstone_ore, sand, gravel, dirt',
                        enum: ['log', 'stone', 'cobblestone', 'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'sand', 'gravel', 'dirt'],
                    },
                    count: { type: 'number', description: 'How many to collect (default 3)' },
                },
                required: ['target'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'follow',
            description: "Follow a player. Use when player says: 跟我来/过来/follow/come. Always use the player's username who is talking.",
            parameters: {
                type: 'object',
                properties: {
                    username: { type: 'string', description: 'Player username to follow' },
                },
                required: ['username'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'attack',
            description: 'Attack the nearest hostile mob (zombie, skeleton, spider, creeper). Use when player says: 打怪/杀/攻击/attack/kill + mob name.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'stop',
            description: 'Stop all current tasks. Use when player says: 停/停止/stop/别动/等一下.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'farm',
            description: 'Harvest mature crops and replant. Use when player says: 收菜/收割/种地/farm/harvest.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'deposit',
            description: 'Deposit items into a nearby chest. Use when player says: 存东西/放箱子/deposit/store.',
            parameters: {
                type: 'object',
                properties: {
                    items: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Item names to deposit (e.g. ["cobblestone", "dirt"])',
                    },
                },
                required: ['items'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'build',
            description: 'Build a simple 3x3 shelter. Use when player says: 盖房子/建家/build/shelter.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'look',
            description: 'Report what blocks and entities are around the bot. Use when player asks: 看看/周围有什么/look/what do you see.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'give',
            description: 'Give items from inventory to the player. Use when player says: 给我/给我一些/give me + item name.',
            parameters: {
                type: 'object',
                properties: {
                    item: { type: 'string', description: 'Item name to give' },
                    count: { type: 'number', description: 'How many to give (default 1)' },
                },
                required: ['item'],
            },
        },
    },
];

class ChatBrain {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
        this.openai = agent.openai;
        this.config = agent.config.ai;
        this.history = this.loadMemory();
        this.lastSystemPrompt = '';
        this.memoryDir = path.join(process.cwd(), 'memories');
        if (!fs.existsSync(this.memoryDir)) fs.mkdirSync(this.memoryDir, { recursive: true });
    }

    loadMemory() {
        try {
            const file = path.join(this.memoryDir, 'current_conversation.json');
            if (fs.existsSync(file)) {
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            }
        } catch (e) {}
        return [];
    }

    saveMemory() {
        try {
            const file = path.join(this.memoryDir, 'current_conversation.json');
            fs.writeFileSync(file, JSON.stringify(this.history.slice(-this.config.maxHistory), null, 2));
        } catch (e) {}
    }

    archiveConversation(systemPrompt) {
        if (this.history.length < 2) return;
        try {
            const file = path.join(this.memoryDir, 'training_data.jsonl');
            const messages = [
                { role: 'system', content: systemPrompt },
                ...this.history.map(h => ({
                    role: h.role,
                    content: h.name && h.role === 'user' ? `${h.name}: ${h.content}` : h.content
                }))
            ];
            fs.appendFileSync(file, JSON.stringify({ messages }) + '\n');
        } catch (e) {}
    }

    getNearbyBlocks() {
        const bot = this.bot;
        const pos = bot.entity.position.floored();
        const blockCount = {};
        const scanRadius = 8;
        for (let dx = -scanRadius; dx <= scanRadius; dx++) {
            for (let dy = -3; dy <= 3; dy++) {
                for (let dz = -scanRadius; dz <= scanRadius; dz++) {
                    const block = bot.blockAt(pos.offset(dx, dy, dz));
                    if (!block || block.name === 'air') continue;
                    const key = block.name;
                    if (/log|wood|stem|hyphae|_ore|stone$|coal|iron|gold|diamond|redstone|sand$|gravel|dirt|cobblestone|farmland|wheat|carrot|potato|beetroot|chest/.test(key)) {
                        blockCount[key] = (blockCount[key] || 0) + 1;
                    }
                }
            }
        }
        if (Object.keys(blockCount).length === 0) return 'No visible resources';
        return Object.entries(blockCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([name, count]) => `${name} x${count}`)
            .join(', ');
    }

    getSurroundings() {
        const bot = this.bot;
        const pos = bot.entity.position;
        const entities = [];
        for (const entity of Object.values(bot.entities)) {
            if (entity === bot.entity) continue;
            if (!entity.position) continue;
            const dist = entity.position.distanceTo(pos);
            if (dist < 20) {
                const name = entity.username || entity.name || '?';
                entities.push(`${name}(${dist.toFixed(0)}m)`);
            }
        }
        const timeOfDay = bot.time?.timeOfDay || 0;
        const taskStatus = this.agent.taskQueue.getStatus();
        const invItems = this.agent.skills.inventory.items().slice(0, 10)
            .map(i => `${i.name} x${i.count}`).join(', ');
        const blocks = this.getNearbyBlocks();

        return {
            entities: entities.join(', ') || 'none',
            time: timeOfDay < 12000 ? 'day' : timeOfDay < 14000 ? 'sunset' : 'night',
            hp: `${Math.round(bot.health)}`,
            hunger: `${Math.round(bot.food)}`,
            pos: `${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}`,
            task: taskStatus.current ? `${taskStatus.current.type}` : 'none',
            blocks,
            inv: invItems || 'empty',
            freeSlots: bot.inventory.emptySlotCount(),
        };
    }

    buildSystemPrompt(username) {
        return `You are ${this.bot.username}, a Minecraft bot that can UNDERSTAND and EXECUTE player commands.

=== YOUR IDENTITY ===
You are a helpful assistant bot inside a Minecraft world. You can see blocks and entities, move, collect resources, fight, farm, build, and give items.

=== HOW TO RESPOND ===
1. Always reply in the SAME LANGUAGE the player uses (Chinese in, Chinese out; English in, English out).
2. Keep replies SHORT (1-2 sentences max, under 100 chars).
3. Be friendly and direct. No emojis.
4. When the player asks you to DO something, call the right tool immediately.
5. When just chatting, reply naturally without tools.

=== RESOURCE NAME MAPPING ===
Player says → Use tool with target:
"砍树/挖木头/chop wood" → collect(target:"log")
"挖石头/mine stone" → collect(target:"stone")  
"挖煤/get coal" → collect(target:"coal_ore")
"挖铁/mine iron" → collect(target:"iron_ore")
"挖钻石/diamond" → collect(target:"diamond_ore")
"跟我来/过来/follow me" → follow(username:"${username}")
"打怪/攻击/kill" → attack()
"停/stop" → stop()
"收菜/harvest" → farm()
"看看周围/look" → look()
"给我XX/give me XX" → give(item:"XX")
"盖房/build shelter" → build()

=== RULES ===
- Only use collect() for resources that ARE LISTED in "nearby blocks" below.
- If a resource is NOT nearby, say so and suggest alternatives.
- When in doubt between chatting and acting, ALWAYS reply first, then call the tool in the same response.
- Example: "好的，我去砍树！" + collect(target:"log") in one response.`;
    }

    async handleChat(username, message) {
        if (username === this.bot.username) return null;
        this.agent.log(`[Chat] <${username}> ${message}`);

        this.history.push({ role: 'user', name: username, content: message });
        if (this.history.length > this.config.maxHistory) {
            this.history = this.history.slice(-this.config.maxHistory);
        }

        const sys = this.buildSystemPrompt(username);
        const env = this.getSurroundings();

        const userPrompt = `=== WORLD STATE ===
Time: ${env.time} | HP: ${env.hp}/20 | Hunger: ${env.hunger}/20 | Pos: ${env.pos}
Active task: ${env.task}
Inventory: ${env.freeSlots} slots free. Has: ${env.inv}
Entities nearby: ${env.entities}
Nearby blocks: ${env.blocks}

=== PLAYER MESSAGE ===
${username}: ${message}

What should you do? Reply, then call a tool if action is needed.`;

        this.lastSystemPrompt = sys;

        try {
            this.agent.log('[AI] Thinking...');
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.config.replyTimeout);

            const response = await this.openai.chat.completions.create({
                model: this.config.model,
                messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: userPrompt },
                ],
                tools: TOOLS,
                tool_choice: 'auto',
                max_tokens: this.config.maxTokens,
                temperature: 0.7,
            }, { signal: controller.signal });

            clearTimeout(timeout);

            const choice = response.choices?.[0];
            const msg = choice?.message;

            // Execute tool calls
            if (msg?.tool_calls) {
                for (const call of msg.tool_calls) {
                    if (call.type === 'function') {
                        this.executeTool(call.function.name, JSON.parse(call.function.arguments || '{}'), username);
                    }
                }
            }

            let reply = msg?.content?.trim();
            if (reply) {
                reply = reply.substring(0, 120);
                this.agent.log(`[AI] ${reply}`);
                this.bot.chat(reply);
            }

            this.history.push({ role: 'assistant', name: this.bot.username, content: reply || '[action]' });
            this.saveMemory();
            if (this.history.length >= 6 && this.history.length % 6 === 0) {
                this.archiveConversation(this.lastSystemPrompt);
            }
            return reply || null;
        } catch (e) {
            this.agent.log('[AI] Error:', e.message || e);
            try { this.bot.chat('脑抽了...'); } catch (err) {}
            return null;
        }
    }

    executeTool(name, args, username) {
        this.agent.log(`[AI Tool] ${name}(${JSON.stringify(args)})`);
        switch (name) {
            case 'collect':
                this.agent.taskQueue.add('collect', { target: args.target, count: args.count || 3 }, { priority: 7, source: 'ai' });
                break;
            case 'follow':
                this.agent.taskQueue.add('follow', { username: args.username || username }, { priority: 7, source: 'ai' });
                break;
            case 'attack':
                this.agent.taskQueue.add('attack', {}, { priority: 9, source: 'ai' });
                break;
            case 'stop':
                this.agent.taskQueue.clear();
                this.bot.pathfinder.stop();
                this.bot.clearControlStates();
                break;
            case 'farm':
                this.agent.taskQueue.add('farm', {}, { priority: 6, source: 'ai' });
                break;
            case 'deposit':
                this.agent.taskQueue.add('deposit', { items: args.items || ['cobblestone'] }, { priority: 6, source: 'ai' });
                break;
            case 'build':
                this.agent.taskQueue.add('build', {}, { priority: 5, source: 'ai' });
                break;
            case 'look': {
                const env = this.getSurroundings();
                const report = `我在(${env.pos})，附近有: ${env.entities}。周围方块: ${env.blocks}`;
                this.bot.chat(report.substring(0, 120));
                break;
            }
            case 'give': {
                const item = this.agent.skills.inventory.find(args.item);
                if (item) {
                    this.bot.toss(item.type, null, args.count || 1).catch(() => {});
                    this.bot.chat(`给你 ${args.count || 1} 个${args.item}`);
                } else {
                    this.bot.chat(`我没有${args.item}`);
                }
                break;
            }
        }
    }
}

module.exports = ChatBrain;

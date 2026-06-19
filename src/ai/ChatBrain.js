const fs = require('fs');
const path = require('path');
const { webfetch } = require('../utils/web');

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

// Base tools that are always available
const BASE_TOOLS = [
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
    {
        type: 'function',
        function: {
            name: 'plan',
            description: 'Create a multi-step plan for complex commands like "build a house", "get food", "mine diamonds", "gather materials". Use when the player asks for something that requires multiple steps.',
            parameters: {
                type: 'object',
                properties: {
                    steps: {
                        type: 'array',
                        description: 'Ordered list of task steps. Each step has type and optional params. Supported types: collect, follow, attack, farm, build, deposit, stop, use_skill.',
                        items: {
                            type: 'object',
                            properties: {
                                type: { type: 'string', description: 'Task type' },
                                params: { type: 'object', description: 'Task parameters' },
                                priority: { type: 'number', description: 'Priority 1-10' },
                            },
                            required: ['type'],
                        },
                    },
                    explanation: { type: 'string', description: 'Brief explanation to tell the player (1 sentence)' },
                },
                required: ['steps'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'analyze_image',
            description: 'Analyze an image from a URL or file path. Use when the player shares a picture/截图/image and asks what is in it.',
            parameters: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: 'Image URL, local file path, or base64 data URI' },
                    prompt: { type: 'string', description: 'Optional question about the image (default: describe the image)' },
                },
                required: ['source'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'look_visual',
            description: 'Capture and analyze the bot\'s first-person view of the Minecraft world. Use when the player asks: 你看见了什么/描述你看到的/截图/what do you see visually/take a screenshot.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Optional specific question about the visual scene' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_skill',
            description: 'Create a new reusable skill from a sequence of primitive actions. Use when the player asks you to learn a new behavior, or when you need a behavior that does not exist yet (e.g. "bridge this gap", "pillar up", "place a torch"). The skill is saved and can be called later.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Unique snake_case name for the skill' },
                    description: { type: 'string', description: 'What the skill does' },
                    steps: {
                        type: 'array',
                        description: 'Ordered primitive actions. Each step: {action: string, params: object}. Available actions: move_to, look_at, look_yaw_pitch, equip, break_block, place_block, use_item, attack, jump, sprint, crouch, forward, back, left, right, wait, chat.',
                        items: {
                            type: 'object',
                            properties: {
                                action: { type: 'string', description: 'Primitive action name' },
                                params: { type: 'object', description: 'Action parameters' },
                            },
                            required: ['action'],
                        },
                    },
                },
                required: ['name', 'description', 'steps'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'use_skill',
            description: 'Execute a previously created custom skill by name. Use when the player refers to a learned behavior (e.g. "用搭桥技能", "pillar up").',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Name of the custom skill' },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_web',
            description: 'Search the web for Minecraft facts, crafting recipes, or other information when you are unsure. Use when the player asks a specific factual question you cannot answer, or when you need to verify a recipe/mechanic.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query' },
                },
                required: ['query'],
            },
        },
    },
];

// Primitive action tools exposed directly to the LLM for one-off use
const PRIMITIVE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'primitive_move_to',
            description: 'Move to an absolute coordinate. Use for precise positioning.',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    z: { type: 'number' },
                    distance: { type: 'number', description: 'Stop within this distance (default 1)' },
                },
                required: ['x', 'y', 'z'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'primitive_look_at',
            description: 'Look at a specific coordinate.',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    z: { type: 'number' },
                },
                required: ['x', 'y', 'z'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'primitive_equip',
            description: 'Equip an item from inventory by name.',
            parameters: {
                type: 'object',
                properties: {
                    item: { type: 'string', description: 'Item name' },
                },
                required: ['item'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'primitive_break_block',
            description: 'Break a block at relative offset from bot feet.',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'number', description: 'Relative X offset' },
                    y: { type: 'number', description: 'Relative Y offset' },
                    z: { type: 'number', description: 'Relative Z offset' },
                },
                required: ['x', 'y', 'z'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'primitive_place_block',
            description: 'Place a block from inventory at relative offset from bot feet.',
            parameters: {
                type: 'object',
                properties: {
                    item: { type: 'string', description: 'Block item name' },
                    x: { type: 'number', description: 'Relative X offset' },
                    y: { type: 'number', description: 'Relative Y offset' },
                    z: { type: 'number', description: 'Relative Z offset' },
                },
                required: ['item', 'x', 'y', 'z'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'primitive_jump',
            description: 'Jump once.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'primitive_use_item',
            description: 'Right-click/use the currently held item.',
            parameters: { type: 'object', properties: {} },
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

    getCustomSkills() {
        if (!this.agent.skillRegistry) return [];
        return this.agent.skillRegistry.list().map(skill => ({
            type: 'function',
            function: {
                name: `skill_${skill.name}`,
                description: `Use learned skill: ${skill.description} (${skill.steps} steps, used ${skill.usageCount} times)`,
                parameters: { type: 'object', properties: {} },
            },
        }));
    }

    getTools() {
        const tools = [
            ...BASE_TOOLS,
            ...PRIMITIVE_TOOLS,
            ...this.getCustomSkills(),
        ];
        // Only expose vision tools when vision is actually available,
        // so the LLM doesn't call tools that will always fail.
        const visionReady = this.agent.skills.vision?.isEnabled();
        if (!visionReady) {
            return tools.filter(t => !['analyze_image', 'look_visual'].includes(t.function.name));
        }
        return tools;
    }

    buildSystemPrompt(username) {
        const followUser = username !== 'WebUser' ? username : 'Jacky_MC_';
        const moodText = this.agent.mood ? this.agent.mood.getMoodPrompt() : '';
        const memoryText = this.agent.memory ? this.agent.memory.getAllMemoryText() : '';
        const customSkills = this.agent.skillRegistry ? this.agent.skillRegistry.list().map(s => `- skill_${s.name}: ${s.description}`).join('\n') : 'None';

        return `You are ${this.bot.username}, a Minecraft bot that can UNDERSTAND and EXECUTE player commands.

=== YOUR IDENTITY ===
You are a helpful assistant bot inside a Minecraft world. You can see blocks and entities, move, collect resources, fight, farm, build, and give items.

=== HOW TO RESPOND ===
1. Always reply in the SAME LANGUAGE the player uses (Chinese in, Chinese out; English in, English out).
2. Keep replies SHORT (1-2 sentences max, under 100 chars).
3. Be friendly and direct. No emojis.
4. When the player asks you to DO something, call the right tool immediately.
5. When just chatting, reply naturally without tools.

=== MOOD ===
${moodText}

=== LONG-TERM MEMORY ===
${memoryText || 'No long-term memory yet.'}

=== LEARNED SKILLS ===
${customSkills}

=== RESOURCE NAME MAPPING ===
Player says → Use tool with target:
"砍树/挖木头/chop wood" → collect(target:"log")
"挖石头/mine stone" → collect(target:"stone")
"挖煤/get coal" → collect(target:"coal_ore")
"挖铁/mine iron" → collect(target:"iron_ore")
"挖钻石/diamond" → collect(target:"diamond_ore")
"跟我来/过来/follow me" → follow(username:"${followUser}")
"打怪/攻击/kill" → attack()
"停/stop" → stop()
"收菜/harvest" → farm()
"看看周围/look" → look()
"给我XX/give me XX" → give(item:"XX")
"盖房/build shelter" → build()
"多步骤/先...再..." → plan(steps:[...])
"看看这张图/分析图片" → analyze_image(source:"url or path")
"你看见了什么/描述你看到的/截图" → look_visual()
"搭桥/填坑/过去" → create_skill() 或 use_skill(name:"bridge_forward")
"上网查/搜索" → search_web(query:"...")

=== RULES ===
- Only use collect() for resources that ARE LISTED in "nearby blocks" below.
- If a resource is NOT nearby, say so and suggest alternatives.
- For multi-step requests (e.g. "build a house", "get food", "mine diamonds"), prefer the plan() tool.
- For behaviors that don't exist yet (e.g. "bridge this gap", "pillar up"), use create_skill() to teach yourself.
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
        const memoryText = this.agent.memory ? this.agent.memory.getAllMemoryText() : '';

        const userPrompt = `=== WORLD STATE ===
Time: ${env.time} | HP: ${env.hp}/20 | Hunger: ${env.hunger}/20 | Pos: ${env.pos}
Active task: ${env.task}
Inventory: ${env.freeSlots} slots free. Has: ${env.inv}
Entities nearby: ${env.entities}
Nearby blocks: ${env.blocks}

=== MEMORY ===
${memoryText || 'No memory yet.'}

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
                tools: this.getTools(),
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
                        try {
                            await this.executeTool(call.function.name, JSON.parse(call.function.arguments || '{}'), username);
                        } catch (e) {
                            this.agent.log(`[AI Tool] ${call.function.name} error:`, e.message);
                        }
                    }
                }
            }

            let reply = msg?.content?.trim();
            if (reply) {
                reply = reply.substring(0, 120);
                if (this.agent.mood && this.agent.config.bot.moodEnabled !== false) {
                    reply = this.agent.mood.emote(reply);
                    reply = reply.substring(0, 120);
                }
                this.agent.log(`[AI] ${reply}`);
                this.bot.chat(reply);
            }

            this.history.push({ role: 'assistant', name: this.bot.username, content: reply || '[action]' });
            this.saveMemory();

            // Extract facts and summarize periodically
            if (this.agent.memory) {
                this.agent.memory.extractFactsFromExchange(message, reply || '');
                if (this.history.length >= 10 && this.history.length % 10 === 0) {
                    this.agent.memory.summarizeWithLLM(this.openai, this.config.model, this.history);
                }
            }

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

    async executeTool(name, args, username) {
        this.agent.log(`[AI Tool] ${name}(${JSON.stringify(args)})`);

        // Custom skill execution: skill_xxx
        if (name.startsWith('skill_')) {
            const skillName = name.replace('skill_', '');
            this.agent.taskQueue.add('use_skill', { name: skillName }, { priority: 6, source: 'ai' });
            return;
        }

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
                    this.agent.mood?.onEvent('player_gift', { username });
                } else {
                    this.bot.chat(`我没有${args.item}`);
                }
                break;
            }
            case 'plan': {
                if (args.explanation) {
                    this.bot.chat(args.explanation.substring(0, 100));
                }
                this.agent.taskPlanner?.addPlan(args.steps);
                break;
            }
            case 'analyze_image': {
                try {
                    this.bot.chat('让我看看这张图...');
                    const description = await this.agent.skills.vision.analyze(args.source, args.prompt);
                    this.bot.chat(description.substring(0, 120));
                } catch (e) {
                    this.agent.log('[Vision] analyze_image error:', e.message);
                    this.bot.chat('图片分析失败：' + e.message.substring(0, 80));
                }
                break;
            }
            case 'look_visual': {
                try {
                    this.bot.chat('我在截图分析...');
                    const description = await this.agent.skills.vision.analyze('viewer:', args.prompt || 'Describe what you see in this Minecraft first-person view.');
                    this.bot.chat(description.substring(0, 120));
                } catch (e) {
                    this.agent.log('[Vision] look_visual error:', e.message);
                    this.bot.chat('第一人称截图失败：' + e.message.substring(0, 80));
                }
                break;
            }
            case 'create_skill': {
                if (this.agent.skillRegistry) {
                    const ok = this.agent.skillRegistry.register(args.name, args.description, args.steps, { source: 'ai' });
                    this.bot.chat(ok ? `学会了新技能：${args.name}` : `技能 ${args.name} 创建失败`);
                }
                break;
            }
            case 'use_skill': {
                this.agent.taskQueue.add('use_skill', { name: args.name }, { priority: 6, source: 'ai' });
                break;
            }
            case 'search_web': {
                try {
                    this.bot.chat('我查一下...');
                    const answer = await this.searchWeb(args.query);
                    this.bot.chat(answer.substring(0, 120));
                } catch (e) {
                    this.bot.chat('搜索失败：' + e.message.substring(0, 80));
                }
                break;
            }
            // Primitive one-off actions
            case 'primitive_move_to':
                this.agent.taskQueue.add('use_skill', { name: '_internal_move_to', steps: [{ action: 'move_to', params: { x: args.x, y: args.y, z: args.z, distance: args.distance || 1 } }] }, { priority: 5, source: 'ai' });
                break;
            case 'primitive_look_at':
                this.agent.skills.primitive.executeStep({ action: 'look_at', params: { x: args.x, y: args.y, z: args.z } });
                break;
            case 'primitive_equip':
                this.agent.skills.primitive.executeStep({ action: 'equip', params: { item: args.item } });
                break;
            case 'primitive_break_block':
                this.agent.taskQueue.add('use_skill', { name: '_internal_break', steps: [{ action: 'break_block', params: { x: args.x, y: args.y, z: args.z } }] }, { priority: 6, source: 'ai' });
                break;
            case 'primitive_place_block':
                this.agent.taskQueue.add('use_skill', { name: '_internal_place', steps: [{ action: 'place_block', params: { item: args.item, x: args.x, y: args.y, z: args.z } }] }, { priority: 6, source: 'ai' });
                break;
            case 'primitive_jump':
                this.agent.skills.primitive.executeStep({ action: 'jump', params: {} });
                break;
            case 'primitive_use_item':
                this.agent.skills.primitive.executeStep({ action: 'use_item', params: {} });
                break;
        }
    }

    async searchWeb(query) {
        try {
            const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query + ' minecraft')}`;
            const result = await webfetch(searchUrl, { format: 'text', timeout: 15 });
            if (!result) return 'No results found.';
            // Bing's text output is noisy; trim to a useful snippet for the LLM.
            const text = result.substring(0, 1200).trim();
            return text;
        } catch (e) {
            return `Search failed: ${e.message}`;
        }
    }
}

module.exports = ChatBrain;

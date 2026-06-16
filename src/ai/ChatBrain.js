const fs = require('fs');
const path = require('path');

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'collect',
            description: 'Collect a resource such as wood, stone, coal, or iron ore.',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'string', description: 'Resource name like log, stone, coal_ore, iron_ore' },
                    count: { type: 'number', description: 'How many to collect' },
                },
                required: ['target'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'follow',
            description: 'Follow a player.',
            parameters: {
                type: 'object',
                properties: {
                    username: { type: 'string', description: 'Player username' },
                },
                required: ['username'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'attack',
            description: 'Attack the nearest hostile mob.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'stop',
            description: 'Stop current task and clear goal.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'farm',
            description: 'Harvest and replant nearby crops.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'deposit',
            description: 'Deposit items into a nearby chest.',
            parameters: {
                type: 'object',
                properties: {
                    items: { type: 'array', items: { type: 'string' }, description: 'Item names to deposit' },
                },
                required: ['items'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'build',
            description: 'Build a simple shelter at current location.',
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
        const taskStatus = this.agent.taskQueue.getStatus();
        return {
            nearby: nearby.slice(0, 6).join(', ') || 'nothing nearby',
            time: timeOfDay < 12000 ? 'day' : 'night',
            hp: `${bot.health ?? '?'}/20`,
            hunger: `${bot.food ?? '?'}/20`,
            position: `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
            task: taskStatus.current ? `${taskStatus.current.type} ${taskStatus.current.params.target || ''}` : 'idle',
            queued: taskStatus.queued,
        };
    }

    async handleChat(username, message) {
        if (username === this.bot.username) return null;
        this.agent.log(`[Chat] <${username}> ${message}`);

        this.history.push({ role: 'user', name: username, content: message });
        if (this.history.length > this.config.maxHistory) {
            this.history = this.history.slice(-this.config.maxHistory);
        }

        const env = this.getSurroundings();

        const systemPrompt = `You are ${this.bot.username}, a self-aware Minecraft bot assistant.
You can understand Chinese and English. Reply in the same language as the player.
Keep replies concise (under 80 chars) and friendly.
When you decide to perform an action, use a tool call.
Available tools: collect, follow, attack, stop, farm, deposit, build.
Do not use emojis. Plain text only.`;

        const userPrompt = `Environment:
- Nearby: ${env.nearby}
- Time: ${env.time}
- HP: ${env.hp}, Hunger: ${env.hunger}
- Position: ${env.position}
- Current task: ${env.task}, queued tasks: ${env.queued}

Recent chat:
${this.history.slice(-6).map(h => `${h.name || this.bot.username}: ${h.content}`).join('\n')}

${username} says: "${message}"`;

        this.lastSystemPrompt = systemPrompt;

        try {
            this.agent.log('[AI] Thinking...');
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.config.replyTimeout);

            const response = await this.openai.chat.completions.create({
                model: this.config.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                tools: TOOLS,
                tool_choice: 'auto',
                max_tokens: this.config.maxTokens,
                temperature: 0.8,
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
                this.agent.taskQueue.add('collect', { target: args.target, count: args.count || 5 }, { priority: 7, source: 'ai' });
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
                this.agent.taskQueue.add('deposit', { items: args.items || [] }, { priority: 6, source: 'ai' });
                break;
            case 'build':
                this.agent.taskQueue.add('build', {}, { priority: 5, source: 'ai' });
                break;
        }
    }
}

module.exports = ChatBrain;

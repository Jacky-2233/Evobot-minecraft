/**
 * Tracks the bot's emotional/mood state and influences chat responses.
 */
class MoodSystem {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
        this.moods = {
            happy: 50,      // 0-100
            scared: 0,      // 0-100
            bored: 30,      // 0-100
            tired: 0,       // 0-100
            grateful: 20,   // 0-100
        };
        this.lastUpdate = Date.now();
        this.lastIdleCheck = Date.now();
        this.playerTrust = new Map(); // username -> 0..100
    }

    update() {
        const now = Date.now();
        const dt = Math.min((now - this.lastUpdate) / 1000, 10);
        this.lastUpdate = now;

        // Boredom rises when idle
        if (this.agent.taskQueue.isIdle()) {
            this.moods.bored = Math.min(100, this.moods.bored + dt * 1.5);
        } else {
            this.moods.bored = Math.max(0, this.moods.bored - dt * 3);
        }

        // Tired rises when health/food low
        if (this.bot.health < 10 || this.bot.food < 10) {
            this.moods.tired = Math.min(100, this.moods.tired + dt * 2);
        } else {
            this.moods.tired = Math.max(0, this.moods.tired - dt * 1);
        }

        // Fear decays over time unless in danger
        this.moods.scared = Math.max(0, this.moods.scared - dt * 2);

        // Happiness slowly normalizes toward neutral
        if (this.moods.happy > 50) this.moods.happy = Math.max(50, this.moods.happy - dt * 0.5);
        if (this.moods.happy < 50) this.moods.happy = Math.min(50, this.moods.happy + dt * 0.5);
    }

    onEvent(event, data = {}) {
        switch (event) {
            case 'damaged':
                this.moods.scared = Math.min(100, this.moods.scared + 30);
                this.moods.happy = Math.max(0, this.moods.happy - 15);
                break;
            case 'killed_enemy':
                this.moods.happy = Math.min(100, this.moods.happy + 20);
                this.moods.scared = Math.max(0, this.moods.scared - 20);
                break;
            case 'collected_rare':
                this.moods.happy = Math.min(100, this.moods.happy + 15);
                break;
            case 'player_gift':
                this.moods.grateful = Math.min(100, this.moods.grateful + 25);
                this.moods.happy = Math.min(100, this.moods.happy + 20);
                if (data.username) {
                    this.trust(data.username, 10);
                }
                break;
            case 'player_chat':
                this.moods.bored = Math.max(0, this.moods.bored - 15);
                break;
            case 'completed_task':
                this.moods.happy = Math.min(100, this.moods.happy + 10);
                this.moods.bored = Math.max(0, this.moods.bored - 10);
                break;
            case 'died':
                this.moods.scared = Math.min(100, this.moods.scared + 60);
                this.moods.happy = Math.max(0, this.moods.happy - 30);
                break;
            case 'idle_long':
                this.moods.bored = Math.min(100, this.moods.bored + 20);
                break;
        }
    }

    trust(username, delta = 0) {
        if (!username) return 50;
        const current = this.playerTrust.get(username) || 50;
        const next = Math.max(0, Math.min(100, current + delta));
        this.playerTrust.set(username, next);
        return next;
    }

    getDominantMood() {
        let maxVal = -1;
        let mood = 'neutral';
        for (const [name, val] of Object.entries(this.moods)) {
            if (val > maxVal) {
                maxVal = val;
                mood = name;
            }
        }
        return { mood, value: maxVal };
    }

    /**
     * Returns a short mood description for the system prompt.
     */
    getMoodPrompt() {
        const dominant = this.getDominantMood();
        const lines = [
            `Current mood: ${dominant.mood} (${dominant.value}/100).`,
            `happy:${Math.round(this.moods.happy)} scared:${Math.round(this.moods.scared)} bored:${Math.round(this.moods.bored)} tired:${Math.round(this.moods.tired)} grateful:${Math.round(this.moods.grateful)}`,
        ];

        if (dominant.mood === 'scared') {
            lines.push('You are frightened. Keep replies short and cautious.');
        } else if (dominant.mood === 'happy') {
            lines.push('You are in a good mood. Be cheerful but still concise.');
        } else if (dominant.mood === 'bored') {
            lines.push('You are bored. You may gently ask the player what to do next, or mention you are going to find something to do.');
        } else if (dominant.mood === 'tired') {
            lines.push('You are tired. Mention resting or eating if relevant.');
        } else if (dominant.mood === 'grateful') {
            lines.push('You feel grateful. Say thanks when appropriate.');
        }

        return lines.join('\n');
    }

    /**
     * Optionally prepend/append a small emotional reaction to a reply.
     */
    emote(reply) {
        if (!reply) return reply;
        const dominant = this.getDominantMood();
        if (dominant.value < 60) return reply;

        const emotes = {
            scared: ['（有点害怕）', '(a bit scared)'],
            happy: ['（开心）', '(happy)'],
            bored: ['（好无聊）', '(bored)'],
            tired: ['（有点累）', '(tired)'],
            grateful: ['（感激）', '(grateful)'],
        };

        const pool = emotes[dominant.mood];
        if (!pool) return reply;

        const tag = pool[Math.floor(Math.random() * pool.length)];
        // keep replies short: append after a space
        return reply.length > 60 ? reply : `${reply} ${tag}`;
    }

    getStatus() {
        return {
            moods: { ...this.moods },
            dominant: this.getDominantMood(),
            trust: Object.fromEntries(this.playerTrust),
        };
    }
}

module.exports = MoodSystem;

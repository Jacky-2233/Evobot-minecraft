const fs = require('fs');
const path = require('path');

/**
 * Hierarchical memory system for the bot.
 * - Working memory: recent conversation (already handled by ChatBrain, but summarized here)
 * - Summary memory: compressed older conversations
 * - Fact memory: extracted important facts (player preferences, locations, etc.)
 */
class MemorySystem {
    constructor(agent) {
        this.agent = agent;
        this.memoryDir = path.join(process.cwd(), 'memories');
        if (!fs.existsSync(this.memoryDir)) fs.mkdirSync(this.memoryDir, { recursive: true });

        this.summaries = this.load('summaries.json') || [];
        this.facts = this.load('facts.json') || [];
    }

    load(fileName) {
        try {
            const file = path.join(this.memoryDir, fileName);
            if (fs.existsSync(file)) {
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            }
        } catch (e) {}
        return null;
    }

    save(fileName, data) {
        try {
            const file = path.join(this.memoryDir, fileName);
            fs.writeFileSync(file, JSON.stringify(data, null, 2));
        } catch (e) {
            this.agent.log('[Memory] Save failed:', e.message);
        }
    }

    addSummary(text, source = 'conversation') {
        this.summaries.push({
            text,
            source,
            at: Date.now(),
        });
        // Keep last 20 summaries
        if (this.summaries.length > 20) this.summaries = this.summaries.slice(-20);
        this.save('summaries.json', this.summaries);
    }

    addFact(fact, category = 'general') {
        // Avoid duplicates
        if (this.facts.some(f => f.text === fact)) return;
        this.facts.push({
            text: fact,
            category,
            at: Date.now(),
        });
        // Keep last 50 facts
        if (this.facts.length > 50) this.facts = this.facts.slice(-50);
        this.save('facts.json', this.facts);
    }

    getSummaries(limit = 5) {
        return this.summaries.slice(-limit).map(s => s.text);
    }

    getFacts(category = null, limit = 10) {
        let facts = this.facts;
        if (category) facts = facts.filter(f => f.category === category);
        return facts.slice(-limit).map(f => f.text);
    }

    getAllMemoryText() {
        const parts = [];
        const summaries = this.getSummaries(3);
        if (summaries.length > 0) {
            parts.push('=== PAST CONVERSATION SUMMARIES ===\n' + summaries.join('\n'));
        }
        const facts = this.getFacts(null, 10);
        if (facts.length > 0) {
            parts.push('=== IMPORTANT FACTS ===\n' + facts.join('\n'));
        }
        return parts.join('\n\n');
    }

    /**
     * Extract facts from a conversation exchange using simple heuristics.
     * More advanced extraction can be done via LLM.
     */
    extractFactsFromExchange(userMsg, botReply) {
        const text = `${userMsg} ${botReply}`;
        const facts = [];

        // Location patterns: "家在 100,64,-200" / "箱子在(100, 64, -200)"
        const locMatch = text.match(/(?:箱子|基地|家|矿石|矿洞|出生点)在\s*\(?\s*(-?\d+)\s*[,，\s]\s*(-?\d+)\s*[,，\s]\s*(-?\d+)\s*\)?/);
        if (locMatch) {
            facts.push({ text: `Location remembered: ${locMatch[1]},${locMatch[2]},${locMatch[3]}`, category: 'location' });
        }

        // Player name: "我叫XXX" / "我是XXX"
        const nameMatch = text.match(/(?:我叫|我是)\s*([^\s，。,!!?]{1,20})/);
        if (nameMatch) {
            facts.push({ text: `Player name: ${nameMatch[1]}`, category: 'identity' });
        }

        // Preference patterns (Chinese)
        const prefMatch = text.match(/(?:我喜欢|我讨厌|我想要|不要|别)([^。，！？\s]+)/);
        if (prefMatch) {
            facts.push({ text: `Player preference: ${prefMatch[0]}`, category: 'preference' });
        }

        // English preferences
        const engPref = text.match(/(?:I like|I hate|I want|I don't want)\s+([^.,]+)/i);
        if (engPref) {
            facts.push({ text: `Player preference: ${engPref[0]}`, category: 'preference' });
        }

        for (const f of facts) this.addFact(f.text, f.category);
    }

    async summarizeWithLLM(openai, model, messages) {
        if (!openai || messages.length < 4) return null;
        try {
            const response = await openai.chat.completions.create({
                model,
                messages: [
                    { role: 'system', content: 'Summarize the following conversation into 1-2 sentences. Keep only important information, player requests, and facts the bot should remember.' },
                    { role: 'user', content: messages.map(m => `${m.role}: ${m.content}`).join('\n') },
                ],
                max_tokens: 100,
                temperature: 0.3,
            });
            const summary = response.choices?.[0]?.message?.content?.trim();
            if (summary) this.addSummary(summary);
            return summary;
        } catch (e) {
            this.agent.log('[Memory] LLM summary failed:', e.message);
            return null;
        }
    }
}

module.exports = MemorySystem;

const fs = require('fs');
const path = require('path');

class EvolutionSystem {
    constructor(botName, logFn = console.log) {
        this.botName = botName;
        this.log = logFn;
        this.dataDir = path.join(process.cwd(), 'evolution');
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
        if (this.experiences.length > 200) this.experiences.shift();
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
            this.log(`[Evolve] New skill learned: ${action} -> ${target}`);
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
        const recent = this.experiences.slice(-20);
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
                this.log(`[Evolve] Reflection: ${insight.substring(0, 100)}`);
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

module.exports = EvolutionSystem;

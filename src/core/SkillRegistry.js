const fs = require('fs');
const path = require('path');

/**
 * SkillRegistry: allows the AI to create, persist, and reuse custom skills.
 * A skill is a named sequence of primitive actions.
 */
class SkillRegistry {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
        this.skills = new Map();
        this.filePath = path.join(process.cwd(), 'memories', 'skills.json');
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                if (Array.isArray(data.skills)) {
                    for (const skill of data.skills) {
                        this.skills.set(skill.name, skill);
                    }
                    this.agent.log(`[SkillRegistry] Loaded ${this.skills.size} custom skills`);
                }
            }
        } catch (e) {
            this.agent.log('[SkillRegistry] Load failed:', e.message);
        }
    }

    save() {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const data = { skills: Array.from(this.skills.values()) };
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
        } catch (e) {
            this.agent.log('[SkillRegistry] Save failed:', e.message);
        }
    }

    /**
     * Register a new skill.
     * @param {string} name - skill name (snake_case)
     * @param {string} description - what this skill does
     * @param {Array} steps - array of {action, params} primitive steps
     * @param {Object} meta - usage count, success count, etc.
     */
    register(name, description, steps, meta = {}) {
        if (!name || !Array.isArray(steps)) return false;
        const skill = {
            name,
            description: description || `Skill: ${name}`,
            steps,
            createdAt: Date.now(),
            usageCount: meta.usageCount || 0,
            successCount: meta.successCount || 0,
            source: meta.source || 'ai',
        };
        this.skills.set(name, skill);
        this.save();
        this.agent.log(`[SkillRegistry] Registered skill: ${name} (${steps.length} steps)`);
        return true;
    }

    get(name) {
        return this.skills.get(name);
    }

    has(name) {
        return this.skills.has(name);
    }

    list() {
        return Array.from(this.skills.values()).map(s => ({
            name: s.name,
            description: s.description,
            steps: s.steps.length,
            usageCount: s.usageCount,
            successCount: s.successCount,
        }));
    }

    getToolDefinitions() {
        return Array.from(this.skills.values()).map(skill => ({
            type: 'function',
            function: {
                name: `skill_${skill.name}`,
                description: `Use custom skill: ${skill.description}. Steps: ${skill.steps.map(s => s.action).join(', ')}`,
                parameters: {
                    type: 'object',
                    properties: {},
                },
            },
        }));
    }

    async execute(name, inlineSteps = null) {
        const skill = inlineSteps ? { name: '_inline', steps: inlineSteps } : this.skills.get(name);
        if (!skill) {
            this.agent.log(`[SkillRegistry] Unknown skill: ${name}`);
            return false;
        }

        this.agent.log(`[SkillRegistry] Executing skill: ${name} (${skill.steps.length} steps)`);
        if (!inlineSteps && this.skills.has(name)) {
            skill.usageCount = (skill.usageCount || 0) + 1;
        }

        let success = true;
        for (let i = 0; i < skill.steps.length; i++) {
            const step = skill.steps[i];
            this.agent.log(`[SkillRegistry] ${name}[${i + 1}/${skill.steps.length}]: ${step.action}`);
            const ok = await this.agent.skills.primitive.executeStep(step);
            if (!ok) {
                this.agent.log(`[SkillRegistry] Step ${i + 1} failed`);
                success = false;
                break;
            }
        }

        if (success && !inlineSteps && this.skills.has(name)) {
            skill.successCount = (skill.successCount || 0) + 1;
        }
        this.save();
        return success;
    }

    /**
     * Register a set of default useful skills.
     */
    registerDefaults() {
        // Pillar straight up: jump, place block at feet while airborne, land on it
        this.register('pillar_up', 'Jump and place a block under feet to climb 1 block straight up. Repeat for each level needed.', [
            { action: 'equip', params: { item: 'dirt' } },
            { action: 'jump', params: {} },
            { action: 'wait', params: { ms: 100 } },
            { action: 'place_block', params: { item: 'dirt', x: 0, y: -1, z: 0 } },
            { action: 'wait', params: { ms: 300 } },
        ], { source: 'default' });

        // Dig down: crouch and break the block directly below feet
        this.register('dig_down', 'Crouch and mine the block directly below feet. Use for digging a 1x1 hole downward.', [
            { action: 'crouch', params: { enabled: true } },
            { action: 'look_at', params: { x: 0, y: -2, z: 0 } },
            { action: 'break_block', params: { x: 0, y: -1, z: 0 } },
            { action: 'crouch', params: { enabled: false } },
            { action: 'move_to', params: { x: 0, y: -1, z: 0, distance: 0 } },
        ], { source: 'default' });

        // Dig up: mine the block directly above head layer
        this.register('dig_up', 'Mine the block above head (2 blocks above feet). Use for clearing a ceiling or upward tunnel.', [
            { action: 'jump', params: {} },
            { action: 'wait', params: { ms: 50 } },
            { action: 'break_block', params: { x: 0, y: 2, z: 0 } },
        ], { source: 'default' });

        // Bridge forward: crouch, place block in front at feet level, step onto it
        this.register('bridge_forward', 'Crouch, place a block 1 block forward at feet level, step onto it. Repeat to cross gaps.', [
            { action: 'equip', params: { item: 'dirt' } },
            { action: 'crouch', params: { enabled: true } },
            { action: 'place_block', params: { item: 'dirt', x: 0, y: 0, z: 1 } },
            { action: 'crouch', params: { enabled: false } },
            { action: 'move_to', params: { x: 0, y: 0, z: 1, distance: 0 } },
        ], { source: 'default' });

        // Step onto a 1-block ledge in front
        this.register('step_up', 'Place a block at the base of a 1-block ledge and jump up', [
            { action: 'equip', params: { item: 'dirt' } },
            { action: 'place_block', params: { item: 'dirt', x: 0, y: 0, z: 1 } },
            { action: 'jump', params: {} },
            { action: 'move_to', params: { x: 0, y: 1, z: 1, distance: 0 } },
        ], { source: 'default' });
    }
}

module.exports = SkillRegistry;

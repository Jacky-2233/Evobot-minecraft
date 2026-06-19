/**
 * Plans multi-step task chains from high-level player commands.
 * Example: "build a house" -> collect wood -> build shelter.
 */
class TaskPlanner {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
    }

    /**
     * Try to interpret a natural-language intent as a task chain.
     * Returns an array of tasks to add to the queue, or null if no chain matches.
     */
    planFromIntent(message) {
        const m = message.toLowerCase();

        // Build a house / 盖房子 / 建家
        if (/build.*(house|shelter|home)|盖房子|建家|搭个房子|造房子/.test(m)) {
            return this.chainBuildShelter();
        }

        // Get food / 找吃的 / 食物
        if (/get.*food|find.*food|hunt.*food|找吃的|食物|饿了/.test(m)) {
            return this.chainGetFood();
        }

        // Mine diamonds / 挖钻石
        if (/mine.*diamond|dig.*diamond|挖钻石/.test(m)) {
            return this.chainMineOre('diamond_ore', 3);
        }

        // Mine iron / 挖铁
        if (/mine.*iron|dig.*iron|挖铁/.test(m)) {
            return this.chainMineOre('iron_ore', 5);
        }

        // Mine coal / 挖煤
        if (/mine.*coal|dig.*coal|挖煤/.test(m)) {
            return this.chainMineOre('coal_ore', 5);
        }

        // Gather wood and stone / 准备材料
        if (/gather.*material|get.*resource|准备材料|收集资源/.test(m)) {
            return this.chainGatherMaterials();
        }

        return null;
    }

    chainBuildShelter() {
        const inv = this.agent.skills.inventory;
        const tasks = [];

        // Need wood -> planks
        if (inv.count('log') < 5) {
            tasks.push({ type: 'collect', params: { target: 'log', count: 6 }, options: { priority: 6, source: 'planner' } });
        }
        // Then build
        tasks.push({ type: 'build', params: {}, options: { priority: 5, source: 'planner' } });
        return tasks;
    }

    chainGetFood() {
        const tasks = [];
        // Try hunting first
        tasks.push({ type: 'attack', params: {}, options: { priority: 6, source: 'planner' } });
        // Then deposit rotten flesh if nothing better
        tasks.push({ type: 'deposit', params: { items: ['rotten_flesh'] }, options: { priority: 3, source: 'planner' } });
        return tasks;
    }

    chainMineOre(oreName, count) {
        const tasks = [];
        tasks.push({ type: 'collect', params: { target: oreName, count }, options: { priority: 7, source: 'planner' } });
        // If inventory gets full during mining, deposit trash
        tasks.push({ type: 'deposit', params: { items: this.agent.config.bot.trashItems }, options: { priority: 4, source: 'planner' } });
        return tasks;
    }

    chainGatherMaterials() {
        const tasks = [];
        tasks.push({ type: 'collect', params: { target: 'log', count: 8 }, options: { priority: 6, source: 'planner' } });
        tasks.push({ type: 'collect', params: { target: 'stone', count: 8 }, options: { priority: 6, source: 'planner' } });
        tasks.push({ type: 'collect', params: { target: 'coal_ore', count: 4 }, options: { priority: 5, source: 'planner' } });
        tasks.push({ type: 'deposit', params: { items: this.agent.config.bot.trashItems }, options: { priority: 3, source: 'planner' } });
        return tasks;
    }

    /**
     * Add a manually specified plan (used by AI `plan` tool).
     */
    addPlan(steps) {
        if (!Array.isArray(steps)) return false;
        const tq = this.agent.taskQueue;
        for (const step of steps) {
            if (!step.type) continue;
            tq.add(step.type, step.params || {}, {
                priority: step.priority ?? 5,
                source: step.source || 'planner',
            });
        }
        return true;
    }
}

module.exports = TaskPlanner;

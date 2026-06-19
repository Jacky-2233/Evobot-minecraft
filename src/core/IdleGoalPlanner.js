const world = require('../utils/world');

/**
 * Picks autonomous goals when the bot is idle.
 * Kept intentionally conservative: mostly follows the player, farms, or mines
 * safe surface resources. Avoids risky wandering/repeated building that can
 * trigger pathfinder edge cases.
 */
class IdleGoalPlanner {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
        this.lastGoalTime = 0;
        this.cooldownMs = 12000;
        this.goalHistory = [];
        this.failures = new Map(); // goal type -> count
        this.lastFailureTime = new Map();
    }

    isOnCooldown(goalType) {
        const lastFail = this.lastFailureTime.get(goalType) || 0;
        // Back off after failures: 30s after 1 fail, 60s after 2, 120s after 3+
        const failCount = this.failures.get(goalType) || 0;
        const backoff = failCount >= 3 ? 120000 : failCount >= 2 ? 60000 : failCount >= 1 ? 30000 : 0;
        return Date.now() - lastFail < backoff;
    }

    recordFailure(goalType) {
        this.failures.set(goalType, (this.failures.get(goalType) || 0) + 1);
        this.lastFailureTime.set(goalType, Date.now());
    }

    recordSuccess(goalType) {
        this.failures.set(goalType, Math.max(0, (this.failures.get(goalType) || 0) - 1));
    }

    async think() {
        if (!this.agent.taskQueue.isIdle()) return null;
        if (Date.now() - this.lastGoalTime < this.cooldownMs) return null;
        this.lastGoalTime = Date.now();

        // Never pick idle goals if in danger or very hungry
        if (this.bot.health <= this.agent.config.bot.lowHealthThreshold) return null;
        if (this.bot.food <= 6) return null;

        const goal = this.chooseGoal();
        if (goal) {
            this.agent.log(`[Idle] Decided to: ${goal.description}`);
            this.goalHistory.push({ at: Date.now(), goal: goal.type, description: goal.description });
            const ok = await this.execute(goal);
            if (ok) {
                this.recordSuccess(goal.type);
            } else {
                this.recordFailure(goal.type);
            }
            return goal;
        }
        return null;
    }

    chooseGoal() {
        const goals = this.evaluateGoals();
        if (goals.length === 0) return null;

        // Weighted random pick, but de-prioritize recently repeated or failed goals
        const weights = goals.map(g => {
            const recent = this.goalHistory.slice(-2).some(h => h.goal === g.type);
            const failedRecently = this.isOnCooldown(g.type);
            let w = g.weight;
            if (recent) w *= 0.3;
            if (failedRecently) w *= 0.1;
            return w;
        });
        const total = weights.reduce((a, b) => a + b, 0);
        if (total <= 0) return null;

        let roll = Math.random() * total;
        for (let i = 0; i < goals.length; i++) {
            roll -= weights[i];
            if (roll <= 0) return goals[i];
        }
        return goals[0];
    }

    evaluateGoals() {
        const goals = [];
        const bot = this.bot;
        const inv = this.agent.skills.inventory;
        const time = bot.time?.timeOfDay || 0;
        const isNight = time >= 13000 && time <= 23000;

        // 1. Follow nearest player (safest social behavior)
        const nearestPlayer = world.getNearestEntityWhere(bot, e => e.type === 'player', 32);
        if (nearestPlayer) {
            goals.push({
                type: 'follow_player',
                description: `follow ${nearestPlayer.username || nearestPlayer.name}`,
                weight: isNight ? 80 : 50,
                params: { username: nearestPlayer.username || nearestPlayer.name },
            });
        }

        // 2. Inventory full -> deposit trash
        if (bot.inventory.emptySlotCount() <= 2) {
            goals.push({
                type: 'deposit',
                description: 'deposit items because inventory is full',
                weight: 90,
                params: { items: this.agent.config.bot.trashItems },
            });
        }

        // 3. Farm mature crops (very safe)
        const crop = world.getNearestBlock(bot, 'wheat', 10) ||
                     world.getNearestBlock(bot, 'carrots', 10) ||
                     world.getNearestBlock(bot, 'potatoes', 10);
        if (crop && world.isMatureCrop(crop)) {
            goals.push({
                type: 'farm',
                description: 'harvest nearby crops',
                weight: 60,
                params: {},
            });
        }

        // 4. Collect wood if low and trees nearby (only daytime, avoid cave trouble)
        if (!isNight && inv.count('log') < 8) {
            const log = world.getNearestBlock(bot, 'log', 14);
            if (log) {
                goals.push({
                    type: 'collect',
                    description: 'collect wood for crafting',
                    weight: 40,
                    params: { target: 'log', count: 4 },
                });
            }
        }

        // 5. Mine safe surface ore if pickaxe available
        if (!isNight && this.hasPickaxe()) {
            const ore = world.getNearestBlock(bot, 'coal_ore', 10) ||
                        world.getNearestBlock(bot, 'iron_ore', 10) ||
                        world.getNearestBlock(bot, 'copper_ore', 10);
            if (ore) {
                goals.push({
                    type: 'collect',
                    description: `mine exposed ${ore.name}`,
                    weight: 35,
                    params: { target: ore.name, count: 3 },
                });
            }
        }

        // 6. Hunt only when actually hungry
        if (bot.food <= 10) {
            const huntable = world.getNearestEntityWhere(bot, e => world.isHuntable(e), 14);
            if (huntable) {
                goals.push({
                    type: 'hunt',
                    description: `hunt ${huntable.name} for food`,
                    weight: 55,
                    params: {},
                });
            }
        }

        return goals;
    }

    hasPickaxe() {
        return this.agent.skills.inventory.items().some(i => i.name.includes('pickaxe'));
    }

    async execute(goal) {
        const tq = this.agent.taskQueue;
        switch (goal.type) {
            case 'follow_player':
                tq.add('follow', goal.params, { priority: 4, source: 'idle' });
                return true;
            case 'deposit':
                tq.add('deposit', goal.params, { priority: 6, source: 'idle' });
                return true;
            case 'hunt':
                tq.add('attack', {}, { priority: 5, source: 'idle' });
                return true;
            case 'collect':
                tq.add('collect', goal.params, { priority: 4, source: 'idle' });
                return true;
            case 'farm':
                tq.add('farm', {}, { priority: 4, source: 'idle' });
                return true;
            default:
                return false;
        }
    }
}

module.exports = IdleGoalPlanner;

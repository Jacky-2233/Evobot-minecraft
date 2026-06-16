class SurvivalSkill {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
        this.eating = false;
        this.lastEatTime = 0;
    }

    loadPlugin() {
        try {
            const autoEatLoader = require('mineflayer-auto-eat').loader;
            this.bot.loadPlugin(autoEatLoader);
            this.bot.autoEat.setOpts({
                priority: 'foodPoints',
                minHunger: this.agent.config.bot.hungerThreshold,
                minHealth: this.agent.config.bot.lowHealthThreshold,
                bannedFood: [],
            });
            this.bot.autoEat.enableAuto();

            this.bot.autoEat.on('eatStart', (opts) => {
                this.agent.log(`[Survival] Eating ${opts.food.name}`);
                this.eating = true;
            });
            this.bot.autoEat.on('eatFinish', () => {
                this.eating = false;
                this.lastEatTime = Date.now();
            });
            this.bot.autoEat.on('eatFail', (err) => {
                this.agent.log('[Survival] Eat failed:', err?.message || err);
                this.eating = false;
            });
        } catch (e) {
            this.agent.log('[Survival] auto-eat plugin failed:', e.message);
        }
    }

    async eatIfNeeded() {
        if (this.eating) return true;
        if (this.bot.food >= this.agent.config.bot.hungerThreshold) return false;
        if (Date.now() - this.lastEatTime < 3000) return false;

        const food = this.findBestFood();
        if (!food) {
            this.agent.log('[Survival] No food in inventory');
            return false;
        }

        this.agent.log(`[Survival] Eating ${food.name}`);
        try {
            this.eating = true;
            await this.bot.equip(food, 'hand');
            await this.bot.consume();
            this.lastEatTime = Date.now();
            return true;
        } catch (e) {
            this.agent.log('[Survival] Eat failed:', e.message);
            return false;
        } finally {
            this.eating = false;
        }
    }

    findBestFood() {
        const foodPriority = {
            'golden_apple': 100, 'enchanted_golden_apple': 200,
            'cooked_beef': 80, 'cooked_porkchop': 80,
            'cooked_mutton': 70, 'cooked_chicken': 60,
            'bread': 50, 'baked_potato': 50,
            'cooked_rabbit': 50, 'cooked_cod': 40, 'cooked_salmon': 40,
            'apple': 30, 'carrot': 25, 'potato': 20,
        };
        let best = null;
        let bestScore = -1;
        for (const item of this.bot.inventory.items()) {
            const score = foodPriority[item.name] || 0;
            if (score > bestScore) {
                bestScore = score;
                best = item;
            }
        }
        return best;
    }

    async healIfCritical() {
        if (this.bot.health > this.agent.config.bot.criticalHealthThreshold) return false;
        const goldenApple = this.bot.inventory.items().find(i => i.name === 'golden_apple' || i.name === 'enchanted_golden_apple');
        if (goldenApple) {
            this.agent.log('[Survival] Eating golden apple!');
            try {
                await this.bot.equip(goldenApple, 'hand');
                await this.bot.consume();
                return true;
            } catch (e) {}
        }
        return this.eatIfNeeded();
    }

    isEating() {
        return this.eating;
    }
}

module.exports = SurvivalSkill;

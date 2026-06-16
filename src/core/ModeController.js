const world = require('../utils/world');

class ModeController {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
        this.modes = [
            this.createSelfPreservationMode(),
            this.createUnstuckMode(),
            this.createCowardiceMode(),
            this.createSelfDefenseMode(),
            this.createHuntingMode(),
            this.createItemCollectingMode(),
            this.createIdleMode(),
        ];
        this.modes.sort((a, b) => b.priority - a.priority);
        this.lastUpdate = Date.now();
        this.cooldowns = new Map();
    }

    setCooldown(modeName, ms) {
        this.cooldowns.set(modeName, Date.now() + ms);
    }

    isOnCooldown(modeName) {
        const until = this.cooldowns.get(modeName);
        return until && Date.now() < until;
    }

    createSelfPreservationMode() {
        return {
            name: 'self_preservation',
            priority: 100,
            update: async () => {
                const bot = this.bot;
                const block = bot.blockAt(bot.entity.position);
                const blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));

                // Drowning - jump up
                if (blockAbove?.name === 'water' || block?.name === 'water') {
                    bot.setControlState('jump', true);
                    return true;
                }
                bot.setControlState('jump', false);

                // On fire / lava - run away
                if (block?.name === 'lava' || block?.name === 'fire' ||
                    blockAbove?.name === 'lava' || blockAbove?.name === 'fire') {
                    this.agent.log('On fire! Moving away!');
                    await this.agent.skills.movement.moveAway(5);
                    return true;
                }

                // Critical health - flee
                if (bot.health <= this.agent.config.bot.criticalHealthThreshold) {
                    this.agent.log('Critical health! Fleeing!');
                    await this.agent.skills.combat.retreat(30);
                    return true;
                }

                // Low health after recent damage - flee
                if (Date.now() - this.agent.lastDamageTime < 5000 && bot.health <= this.agent.config.bot.lowHealthThreshold) {
                    this.agent.log('Low health! Retreating!');
                    await this.agent.skills.combat.retreat(20);
                    return true;
                }

                return false;
            }
        };
    }

    createUnstuckMode() {
        return {
            name: 'unstuck',
            priority: 90,
            update: async () => {
                if (this.isOnCooldown('unstuck')) return false;
                const bot = this.bot;
                const pos = bot.entity.position;
                if (!this.prevPos) {
                    this.prevPos = pos.clone();
                    this.stuckStart = Date.now();
                    return false;
                }
                if (pos.distanceTo(this.prevPos) > 0.5) {
                    this.prevPos = pos.clone();
                    this.stuckStart = Date.now();
                    return false;
                }
                const threshold = this.agent.taskQueue.currentTask ? 20000 : 120000;
                if (Date.now() - this.stuckStart > threshold) {
                    this.agent.log('Stuck! Breaking out...');
                    this.setCooldown('unstuck', 5000);
                    await this.agent.skills.movement.unstuck();
                    this.prevPos = pos.clone();
                    this.stuckStart = Date.now();
                    return true;
                }
                return false;
            }
        };
    }

    createCowardiceMode() {
        return {
            name: 'cowardice',
            priority: 80,
            update: async () => {
                if (this.isOnCooldown('cowardice')) return false;
                const enemy = world.getNearestEntityWhere(this.bot, e => world.isHostile(e), 16);
                if (enemy && this.bot.health <= this.agent.config.bot.lowHealthThreshold) {
                    this.agent.log(`Aaa! A ${enemy.name}! Running away!`);
                    this.setCooldown('cowardice', 3000);
                    await this.agent.skills.combat.fleeFrom(enemy, 24);
                    return true;
                }
                return false;
            }
        };
    }

    createSelfDefenseMode() {
        return {
            name: 'self_defense',
            priority: 70,
            update: async () => {
                const enemy = world.getNearestEntityWhere(this.bot, e => world.isHostile(e), 8);
                if (enemy) {
                    this.agent.log(`Fighting ${enemy.name}!`);
                    await this.agent.skills.combat.attackEntity(enemy);
                    return true;
                }
                return false;
            }
        };
    }

    createHuntingMode() {
        return {
            name: 'hunting',
            priority: 30,
            update: async () => {
                if (!this.agent.taskQueue.isIdle()) return false;
                if (this.isOnCooldown('hunting')) return false;
                const huntable = world.getNearestEntityWhere(this.bot, e => world.isHuntable(e), 12);
                if (huntable) {
                    this.agent.log(`Hunting ${huntable.name}!`);
                    this.setCooldown('hunting', 2000);
                    await this.agent.skills.combat.attackEntity(huntable);
                    return true;
                }
                return false;
            }
        };
    }

    createItemCollectingMode() {
        return {
            name: 'item_collecting',
            priority: 20,
            failCount: 0,
            update: async () => {
                if (!this.agent.taskQueue.isIdle()) return false;
                // Backoff on repeated failures
                if (this.failCount > 3) {
                    if (!this.itemCooldown) this.itemCooldown = Date.now() + 30000;
                    if (Date.now() < this.itemCooldown) return false;
                    this.failCount = 0;
                    this.itemCooldown = null;
                }
                const item = world.getNearestEntityWhere(this.bot, e => e.name === 'item', 6);
                if (item && this.bot.inventory.emptySlotCount() > 1) {
                    this.agent.log('Picking up item!');
                    const reached = await this.agent.skills.movement.goto(item.position, 1, 4000);
                    if (!reached) {
                        this.failCount++;
                        this.setCooldown('item_collecting', 3000); // fail cooldown
                    } else {
                        this.failCount = 0;
                    }
                    this.setCooldown('item_collecting', reached ? 500 : 3000);
                    return true;
                }
                return false;
            }
        };
    }

    createIdleMode() {
        return {
            name: 'idle',
            priority: 0,
            update: async () => {
                if (!this.agent.taskQueue.isIdle()) return false;
                return false;
            }
        };
    }

    async update() {
        for (const mode of this.modes) {
            if (mode._running) continue;
            if (this.isOnCooldown(mode.name)) continue;
            mode._running = true;
            try {
                const triggered = await mode.update();
                mode._running = false;
                if (triggered) {
                    this.setCooldown(mode.name, 1000);
                    return mode.name;
                }
            } catch (e) {
                mode._running = false;
                this.agent.log(`[Mode ${mode.name}] Error:`, e.message);
            }
        }
        return null;
    }
}

module.exports = ModeController;

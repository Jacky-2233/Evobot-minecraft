const world = require('../utils/world');

const WEAPON_ORDER = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'];
const ARMOR_ORDER = ['helmet', 'chestplate', 'leggings', 'boots'];
const ARMOR_MATERIALS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather'];

class CombatSkill {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
        this.pvp = null;
        this.activeTarget = null;
    }

    loadPlugin() {
        try {
            const mineflayerPvp = require('mineflayer-pvp').plugin;
            this.bot.loadPlugin(mineflayerPvp);
            this.pvp = this.bot.pvp;
        } catch (e) {
            this.agent.log('[Combat] mineflayer-pvp plugin failed to load:', e.message);
        }
    }

    getWeaponScore(item) {
        if (!item) return -1;
        const idx = WEAPON_ORDER.indexOf(item.name);
        return idx === -1 ? -1 : WEAPON_ORDER.length - idx;
    }

    equipBestWeapon() {
        const items = this.bot.inventory.items();
        let best = null;
        let bestScore = -1;
        for (const item of items) {
            const score = this.getWeaponScore(item);
            if (score > bestScore) {
                bestScore = score;
                best = item;
            }
        }
        if (best) {
            this.bot.equip(best, 'hand').catch(() => {});
        }
    }

    equipArmor() {
        const slotMap = {
            helmet: 'head',
            chestplate: 'torso',
            leggings: 'legs',
            boots: 'feet',
        };
        for (const slot of ARMOR_ORDER) {
            const destSlot = slotMap[slot];
            let current = null;
            try { current = this.bot.inventory.slots[this.bot.getEquipmentDestSlot(destSlot)]; } catch (e) {}
            let best = current;
            let bestScore = current ? this.getArmorScore(current) : -1;

            for (const item of this.bot.inventory.items()) {
                if (item.name.includes(slot)) {
                    const score = this.getArmorScore(item);
                    if (score > bestScore) {
                        bestScore = score;
                        best = item;
                    }
                }
            }

            if (best && best !== current) {
                this.bot.equip(best, destSlot).catch(() => {});
            }
        }
    }

    getArmorScore(item) {
        if (!item) return -1;
        for (let i = 0; i < ARMOR_MATERIALS.length; i++) {
            if (item.name.includes(ARMOR_MATERIALS[i])) return ARMOR_MATERIALS.length - i;
        }
        return 0;
    }

    equipShield() {
        const shield = this.bot.inventory.items().find(i => i.name === 'shield');
        if (shield) {
            this.bot.equip(shield, 'off-hand').catch(() => {});
        }
    }

    async attackEntity(entity) {
        if (!entity) return false;
        this.activeTarget = entity;
        this.equipBestWeapon();
        this.equipArmor();

        try {
            if (this.pvp) {
                this.pvp.attack(entity);
                // Attack for a few seconds then let update loop decide
                await new Promise(r => setTimeout(r, 4000));
                this.pvp.stop();
            } else {
                await this.bot.pathfinder.goto(new GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
                this.bot.lookAt(entity.position.offset(0, entity.height * 0.5, 0));
                this.bot.attack(entity);
            }
            return true;
        } catch (e) {
            this.agent.log('[Combat] Attack error:', e.message);
            return false;
        } finally {
            this.activeTarget = null;
        }
    }

    async retreat(distance = 20) {
        const enemy = world.getNearestEntityWhere(this.bot, e => world.isHostile(e), 16);
        if (enemy) {
            await this.agent.skills.movement.moveAwayFrom(enemy, distance);
        } else {
            await this.agent.skills.movement.moveAway(distance);
        }
    }

    async fleeFrom(entity, distance = 24) {
        await this.agent.skills.movement.moveAwayFrom(entity, distance);
    }

    blockWithShield() {
        const offHand = this.bot.inventory.slots[45]; // off-hand slot
        if (offHand && offHand.name === 'shield') {
            this.bot.setControlState('useItem', true);
            setTimeout(() => this.bot.setControlState('useItem', false), 1000);
        }
    }
}

module.exports = CombatSkill;

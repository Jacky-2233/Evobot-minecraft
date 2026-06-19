const { GoalNear } = require('mineflayer-pathfinder').goals;
const world = require('../utils/world');

/**
 * Primitive action layer: low-level operations that the AI can compose
 * into custom skills. These are the "atoms" of bot behavior.
 *
 * Coordinate convention: most actions take RELATIVE offsets (x,y,z) from
 * the bot's current feet position, so skills stay portable across locations.
 */
class PrimitiveActions {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
    }

    async moveTo(x, y, z, distance = 1, timeoutMs = 10000) {
        const pos = this.bot.entity.position.floored().offset(x, y, z);
        return this.agent.skills.movement.gotoXYZ(pos.x + 0.5, pos.y, pos.z + 0.5, distance, timeoutMs);
    }

    async lookAt(x, y, z) {
        try {
            if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return false;
            const pos = this.bot.entity.position.floored().offset(x, y, z);
            this.bot.lookAt(pos.offset(0.5, 0.5, 0.5));
            return true;
        } catch (e) {
            return false;
        }
    }

    async lookYawPitch(yaw, pitch) {
        try {
            this.bot.look(yaw, pitch, true);
            return true;
        } catch (e) {
            return false;
        }
    }

    async equip(itemName) {
        const item = this.agent.skills.inventory.find(itemName);
        if (!item) return false;
        try {
            await this.bot.equip(item, 'hand');
            return true;
        } catch (e) {
            return false;
        }
    }

    async breakBlock(x, y, z) {
        if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return false;
        const pos = this.bot.entity.position.floored().offset(x, y, z);
        const block = this.bot.blockAt(pos);
        if (!block || block.name === 'air') return false;
        try {
            this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
            await new Promise(r => setTimeout(r, 100));
            await this.agent.skills.inventory.equipBestTool(block);
            await this.agent.skills.gather.safeDig(block);
            return true;
        } catch (e) {
            return false;
        }
    }

    async placeBlock(itemName, x, y, z) {
        if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return false;
        const pos = this.bot.entity.position.floored().offset(x, y, z);
        this.bot.lookAt(pos.offset(0.5, 0.5, 0.5));
        await new Promise(r => setTimeout(r, 100));
        return this.agent.skills.building.placeBlockAt(pos, itemName);
    }

    async useItem() {
        try {
            this.bot.setControlState('useItem', true);
            await new Promise(r => setTimeout(r, 250));
            this.bot.setControlState('useItem', false);
            return true;
        } catch (e) {
            return false;
        }
    }

    async attackOnce() {
        // bot.attack(entity) requires a target entity. Pick the nearest
        // attackable entity (hostile first, then huntable) within reach.
        try {
            let target = world.getNearestEntityWhere(this.bot, e => world.isHostile(e), 4);
            if (!target) target = world.getNearestEntityWhere(this.bot, e => world.isHuntable(e), 4);
            if (!target) {
                this.agent.log('[Primitive] attack: no entity in reach');
                return false;
            }
            await this.bot.lookAt(target.position.offset(0, target.height * 0.5, 0));
            this.bot.attack(target);
            return true;
        } catch (e) {
            return false;
        }
    }

    async jump() {
        try {
            this.bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 250));
            this.bot.setControlState('jump', false);
            return true;
        } catch (e) {
            return false;
        }
    }

    async sprint(enabled = true) {
        try {
            this.bot.setControlState('sprint', enabled);
            return true;
        } catch (e) {
            return false;
        }
    }

    async crouch(enabled = true) {
        try {
            this.bot.setControlState('sneak', enabled);
            return true;
        } catch (e) {
            return false;
        }
    }

    async forward(enabled = true) {
        try {
            this.bot.setControlState('forward', enabled);
            return true;
        } catch (e) {
            return false;
        }
    }

    async back(enabled = true) {
        try {
            this.bot.setControlState('back', enabled);
            return true;
        } catch (e) {
            return false;
        }
    }

    async left(enabled = true) {
        try {
            this.bot.setControlState('left', enabled);
            return true;
        } catch (e) {
            return false;
        }
    }

    async right(enabled = true) {
        try {
            this.bot.setControlState('right', enabled);
            return true;
        } catch (e) {
            return false;
        }
    }

    async wait(ms) {
        await new Promise(r => setTimeout(r, ms));
        return true;
    }

    async chat(message) {
        if (this.bot?.chat) {
            this.bot.chat(message.substring(0, 100));
            return true;
        }
        return false;
    }

    /**
     * Execute a single primitive action step.
     */
    async executeStep(step) {
        const { action, params = {} } = step;
        switch (action) {
            case 'move_to':
                return await this.moveTo(params.x, params.y, params.z, params.distance, params.timeout);
            case 'look_at':
                return await this.lookAt(params.x, params.y, params.z);
            case 'look_yaw_pitch':
                return await this.lookYawPitch(params.yaw, params.pitch);
            case 'equip':
                return await this.equip(params.item);
            case 'break_block':
                return await this.breakBlock(params.x, params.y, params.z);
            case 'place_block':
                return await this.placeBlock(params.item, params.x, params.y, params.z);
            case 'use_item':
                return await this.useItem();
            case 'attack':
                return await this.attackOnce();
            case 'jump':
                return await this.jump();
            case 'sprint':
                return await this.sprint(params.enabled);
            case 'crouch':
                return await this.crouch(params.enabled);
            case 'forward':
                return await this.forward(params.enabled);
            case 'back':
                return await this.back(params.enabled);
            case 'left':
                return await this.left(params.enabled);
            case 'right':
                return await this.right(params.enabled);
            case 'wait':
                return await this.wait(params.ms || 500);
            case 'chat':
                return await this.chat(params.message);
            default:
                this.agent.log(`[Primitive] Unknown action: ${action}`);
                return false;
        }
    }
}

module.exports = PrimitiveActions;

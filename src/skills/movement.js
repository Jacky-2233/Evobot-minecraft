const { GoalNear, GoalFollow } = require('mineflayer-pathfinder').goals;

class MovementSkill {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
    }

    async goto(target, distance = 1, timeoutMs = 10000) {
        if (!target) return false;
        const pos = target.position || target;
        return this.gotoXYZ(pos.x, pos.y, pos.z, distance, timeoutMs);
    }

    async gotoXYZ(x, y, z, distance = 1, timeoutMs = 10000) {
        if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return false;
        const pos = this.bot.entity.position;
        if (Number.isNaN(pos.x) || Number.isNaN(pos.y) || Number.isNaN(pos.z)) return false;
        try {
            await Promise.race([
                this.bot.pathfinder.goto(new GoalNear(x, y, z, distance)),
                new Promise((_, reject) => setTimeout(() => reject(new Error('movement timeout')), timeoutMs))
            ]);
            return true;
        } catch (e) {
            this.bot.pathfinder.stop();
            return false;
        }
    }

    async follow(entity, distance = 3, timeoutMs = 10000) {
        if (!entity) return false;
        try {
            await Promise.race([
                this.bot.pathfinder.goto(new GoalFollow(entity, distance)),
                new Promise((_, reject) => setTimeout(() => reject(new Error('follow timeout')), timeoutMs))
            ]);
            return true;
        } catch (e) {
            this.bot.pathfinder.stop();
            return false;
        }
    }

    async moveAway(distance) {
        const pos = this.bot.entity.position;
        const dx = (Math.random() - 0.5) * distance * 2;
        const dz = (Math.random() - 0.5) * distance * 2;
        return this.gotoXYZ(pos.x + dx, pos.y, pos.z + dz, 1, 5000);
    }

    async moveAwayFrom(entity, distance) {
        const pos = this.bot.entity.position;
        const epos = entity.position;
        const dx = pos.x - epos.x;
        const dz = pos.z - epos.z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        return this.gotoXYZ(
            pos.x + (dx / len) * distance,
            pos.y,
            pos.z + (dz / len) * distance,
            1,
            5000
        );
    }

    async unstuck() {
        const bot = this.bot;
        bot.clearControlStates();
        bot.pathfinder.stop();

        const pos = bot.entity.position;
        if (Number.isNaN(pos.x) || Number.isNaN(pos.y) || Number.isNaN(pos.z)) return;
        const directions = [
            { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
            { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
            { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }
        ];

        // Only break soft/natural blocks (stone breaking caused NaN on some servers)
        const breakable = ['leaves', 'log', 'wood', 'stem', 'hyphae', 'grass', 'dirt'];

        for (const dir of directions) {
            const block = bot.blockAt(pos.offset(dir.x, dir.y, dir.z));
            if (block && breakable.some(b => block.name.includes(b))) {
                this.agent.log(`Breaking ${block.name}...`);
                try {
                    await this.agent.skills.inventory.equipBestTool(block);
                    bot.lookAt(block.position);
                    await this.agent.skills.gather.safeDig(block);
                } catch (e) {}
            }
        }

        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 500));
        bot.setControlState('jump', false);
        await this.moveAway(3);
    }
}

module.exports = MovementSkill;

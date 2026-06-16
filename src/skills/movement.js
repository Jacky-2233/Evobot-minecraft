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
        const directions = [
            { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
            { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
            { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }
        ];

        // Breakable blocks: leaves, logs, grass, dirt, stone, deepslate, ores
        const breakable = ['leaves', 'log', 'wood', 'stem', 'hyphae', 'grass', 'dirt', '_ore', 'stone', 'deepslate', 'cobblestone', 'tuff'];

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

        // If deep underground, prioritize going up
        if (pos.y < 0) {
            // Dig 2 blocks above
            for (let up = 2; up <= 3; up++) {
                const block = bot.blockAt(pos.offset(0, up, 0));
                if (block && breakable.some(b => block.name.includes(b))) {
                    try {
                        await this.agent.skills.inventory.equipBestTool(block);
                        bot.lookAt(block.position);
                        await this.agent.skills.gather.safeDig(block);
                    } catch (e) {}
                }
            }
            // Jump and try to move to a higher position
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 500));
            bot.setControlState('jump', false);
            // Move toward higher ground: try y+5
            await this.gotoXYZ(pos.x, pos.y + 3, pos.z, 1, 3000);
        } else {
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 500));
            bot.setControlState('jump', false);
            await this.moveAway(3);
        }
    }
}

module.exports = MovementSkill;

const { GoalNear } = require('mineflayer-pathfinder').goals;
const world = require('../utils/world');

class GatherSkill {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
    }

    async safeDig(block, timeoutMs = 5000) {
        if (!block || !block.position) return false;
        const bp = block.position;
        if (Number.isNaN(bp.x) || Number.isNaN(bp.y) || Number.isNaN(bp.z)) return false;
        await this.agent.skills.inventory.equipBestTool(block);
        let current = block;
        for (let i = 0; i < 5; i++) {
            try {
                const pos = current.position;
                if (Number.isNaN(pos.x) || Number.isNaN(pos.y) || Number.isNaN(pos.z)) return false;
                await this.bot.dig(current);
                const check = this.bot.blockAt(pos);
                if (!check || check.name !== block.name) return true;
                current = check;
            } catch (e) {
                await new Promise(r => setTimeout(r, 200));
            }
        }
        return false;
    }

    async harvestTree(startBlock, maxDist = 12) {
        const visited = new Set();
        const toVisit = [startBlock.position];
        const logs = [];

        while (toVisit.length > 0) {
            const pos = toVisit.shift();
            const key = `${pos.x},${pos.y},${pos.z}`;
            if (visited.has(key)) continue;
            visited.add(key);

            const block = this.bot.blockAt(pos);
            if (block && world.isLog(block)) {
                logs.push(block);
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            if (dx === 0 && dy === 0 && dz === 0) continue;
                            const neighbor = pos.offset(dx, dy, dz);
                            if (startBlock.position.distanceTo(neighbor) < maxDist) {
                                toVisit.push(neighbor);
                            }
                        }
                    }
                }
            }
        }

        if (logs.length === 0) return false;
        logs.sort((a, b) => a.position.y - b.position.y);

        this.agent.log(`[Gather] Tree has ${logs.length} logs`);
        let dug = 0;
        for (const log of logs) {
            try {
                await this.agent.skills.movement.goto(log.position, 1, 8000);
                if (await this.safeDig(log)) dug++;
            } catch (e) {
                this.bot.pathfinder.stop();
            }
        }
        this.agent.log(`[Gather] Dug ${dug}/${logs.length} logs`);
        return dug > 0;
    }

    async collectBlock(blockName, maxDistance = 30, targetCount = 1) {
        let collected = 0;
        let attempts = 0;
        while (collected < targetCount && attempts < targetCount * 3) {
            attempts++;
            const block = world.getNearestBlock(this.bot, blockName, maxDistance);
            if (!block) {
                this.agent.log(`[Gather] No ${blockName} found nearby`);
                break;
            }

            let success = false;
            try {
                if (world.isLog(block)) {
                    success = await this.harvestTree(block);
                } else {
                    await this.agent.skills.movement.goto(block.position, 1, 10000);
                    success = await this.safeDig(block);
                }
            } catch (e) {
                this.agent.log('[Gather] Error:', e.message);
            }

            if (success) {
                collected++;
                this.agent.log(`[Gather] Collected ${blockName} ${collected}/${targetCount}`);
            } else {
                break;
            }
        }
        return collected;
    }

    async mineOre(oreName, maxDistance = 30, targetCount = 5) {
        return this.collectBlock(oreName, maxDistance, targetCount);
    }
}

module.exports = GatherSkill;

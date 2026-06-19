const { GoalNear } = require('mineflayer-pathfinder').goals;

class BuildingSkill {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
    }

    async placeBlock(blockName, x, y, z) {
        const item = this.agent.skills.inventory.find(blockName);
        if (!item) {
            this.agent.log(`[Build] No ${blockName} in inventory`);
            return false;
        }

        const targetPos = this.bot.entity.position.offset(0, -1, 0).floored();
        const referenceBlock = this.bot.blockAt(targetPos);
        if (!referenceBlock) return false;

        try {
            await this.bot.equip(item, 'hand');
            const placePos = referenceBlock.position.offset(x - referenceBlock.position.x, y - referenceBlock.position.y, z - referenceBlock.position.z);
            const faceVector = placePos.minus(referenceBlock.position);
            await this.bot.placeBlock(referenceBlock, faceVector);
            return true;
        } catch (e) {
            this.agent.log('[Build] Place block error:', e.message);
            return false;
        }
    }

    async buildWall(corner, width, height, material = 'cobblestone') {
        let placed = 0;
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                const pos = corner.offset(x, y, 0);
                const block = this.bot.blockAt(pos);
                if (block && block.name === 'air') {
                    if (await this.placeBlockAt(pos, material)) placed++;
                }
            }
        }
        return placed;
    }

    async placeBlockAt(pos, material) {
        const item = this.agent.skills.inventory.find(material);
        if (!item) return false;

        // Find an adjacent solid block to place against
        const directions = [
            { dx: 1, dy: 0, dz: 0 }, { dx: -1, dy: 0, dz: 0 },
            { dx: 0, dy: 1, dz: 0 }, { dx: 0, dy: -1, dz: 0 },
            { dx: 0, dy: 0, dz: 1 }, { dx: 0, dy: 0, dz: -1 },
        ];

        for (const dir of directions) {
            const refPos = pos.offset(dir.dx, dir.dy, dir.dz);
            const refBlock = this.bot.blockAt(refPos);
            if (refBlock && refBlock.name !== 'air' && refBlock.boundingBox !== 'empty') {
                try {
                    await this.bot.equip(item, 'hand');
                    await this.bot.placeBlock(refBlock, { x: -dir.dx, y: -dir.dy, z: -dir.dz });
                    return true;
                } catch (e) {}
            }
        }
        return false;
    }

    async buildShelter(center) {
        const size = 3;
        const floorY = center.y;
        let placed = 0;

        // Build walls and roof
        for (let x = -size; x <= size; x++) {
            for (let z = -size; z <= size; z++) {
                for (let y = 0; y <= 3; y++) {
                    const pos = center.offset(x, y, z);
                    if (x === -size || x === size || z === -size || z === size || y === 3) {
                        const block = this.bot.blockAt(pos);
                        if (block && block.name === 'air') {
                            if (await this.placeBlockAt(pos, 'cobblestone')) placed++;
                        }
                    }
                }
            }
        }
        this.agent.log(`[Build] Shelter placed ${placed} blocks`);
        return placed;
    }
}

module.exports = BuildingSkill;

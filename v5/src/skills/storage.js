const { GoalNear } = require('mineflayer-pathfinder').goals;

class StorageSkill {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
    }

    findNearbyChest(maxDistance = 16) {
        const pos = this.bot.entity.position.floored();
        let nearest = null;
        let minDist = Infinity;
        for (let dx = -maxDistance; dx <= maxDistance; dx++) {
            for (let dy = -2; dy <= 4; dy++) {
                for (let dz = -maxDistance; dz <= maxDistance; dz++) {
                    const block = this.bot.blockAt(pos.offset(dx, dy, dz));
                    if (block && (block.name === 'chest' || block.name === 'trapped_chest')) {
                        const dist = pos.distanceTo(block.position);
                        if (dist < minDist) {
                            minDist = dist;
                            nearest = block;
                        }
                    }
                }
            }
        }
        return nearest;
    }

    async deposit(itemNames, maxDistance = 16) {
        const chestBlock = this.findNearbyChest(maxDistance);
        if (!chestBlock) {
            this.agent.log('[Storage] No chest found nearby');
            return false;
        }

        try {
            await this.agent.skills.movement.goto(chestBlock.position, 2, 8000);
            const chest = await this.bot.openContainer(chestBlock);

            for (const name of itemNames) {
                const items = this.bot.inventory.items().filter(i => i.name.includes(name));
                for (const item of items) {
                    await chest.deposit(item.type, null, item.count);
                }
            }

            await chest.close();
            this.agent.log('[Storage] Deposited items');
            return true;
        } catch (e) {
            this.agent.log('[Storage] Deposit error:', e.message);
            return false;
        }
    }

    async withdraw(itemName, count = 1, maxDistance = 16) {
        const chestBlock = this.findNearbyChest(maxDistance);
        if (!chestBlock) {
            this.agent.log('[Storage] No chest found nearby');
            return false;
        }

        try {
            await this.agent.skills.movement.goto(chestBlock.position, 2, 8000);
            const chest = await this.bot.openContainer(chestBlock);

            const item = chest.items().find(i => i.name.includes(itemName));
            if (item) {
                const amount = Math.min(count, item.count);
                await chest.withdraw(item.type, null, amount);
            }

            await chest.close();
            return true;
        } catch (e) {
            this.agent.log('[Storage] Withdraw error:', e.message);
            return false;
        }
    }
}

module.exports = StorageSkill;

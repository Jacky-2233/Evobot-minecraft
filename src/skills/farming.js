const world = require('../utils/world');

const CROP_SEEDS = {
    'wheat': 'wheat_seeds',
    'carrots': 'carrot',
    'potatoes': 'potato',
    'beetroots': 'beetroot_seeds',
};

const BREED_FOODS = {
    'cow': 'wheat', 'sheep': 'wheat',
    'pig': ['carrot', 'potato', 'beetroot'],
    'chicken': ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds'],
    'rabbit': ['carrot', 'dandelion'],
};

class FarmingSkill {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
    }

    async harvestCrops(maxDistance = 16) {
        const pos = this.bot.entity.position.floored();
        let harvested = 0;
        for (let dx = -maxDistance; dx <= maxDistance; dx++) {
            for (let dy = -2; dy <= 2; dy++) {
                for (let dz = -maxDistance; dz <= maxDistance; dz++) {
                    const block = this.bot.blockAt(pos.offset(dx, dy, dz));
                    if (block && world.isMatureCrop(block)) {
                        try {
                            await this.agent.skills.movement.goto(block.position, 1, 5000);
                            await this.agent.skills.gather.safeDig(block);
                            harvested++;
                            await this.replantCrop(block);
                        } catch (e) {
                            this.agent.log('[Farming] Harvest error:', e.message);
                        }
                    }
                }
            }
        }
        if (harvested > 0) this.agent.log(`[Farming] Harvested ${harvested} crops`);
        return harvested;
    }

    async replantCrop(oldBlock) {
        const seedName = CROP_SEEDS[oldBlock.name];
        if (!seedName) return false;
        const seed = this.agent.skills.inventory.find(seedName);
        if (!seed) return false;

        const soil = this.bot.blockAt(oldBlock.position.offset(0, -1, 0));
        if (!soil || (soil.name !== 'farmland' && soil.name !== 'dirt' && soil.name !== 'grass_block')) return false;

        try {
            await this.bot.equip(seed, 'hand');
            await this.bot.placeBlock(this.bot.blockAt(oldBlock.position.offset(0, -1, 0)), { x: 0, y: 1, z: 0 });
            return true;
        } catch (e) {
            return false;
        }
    }

    async breedAnimals(animalName, maxDistance = 16) {
        const food = BREED_FOODS[animalName];
        if (!food) return false;
        const foodList = Array.isArray(food) ? food : [food];
        const foodItem = foodList.map(f => this.agent.skills.inventory.find(f)).find(Boolean);
        if (!foodItem) {
            this.agent.log(`[Farming] No food to breed ${animalName}`);
            return false;
        }

        let bred = 0;
        for (const entity of Object.values(this.bot.entities)) {
            if (entity.name !== animalName) continue;
            if (entity.position.distanceTo(this.bot.entity.position) > maxDistance) continue;
            if (entity.metadata && entity.metadata[16] === false) continue; // already bred cooldown

            try {
                await this.bot.equip(foodItem, 'hand');
                await this.agent.skills.movement.goto(entity.position, 2, 5000);
                await this.bot.useOn(entity);
                bred++;
                if (bred >= 2) break; // Need 2 animals
            } catch (e) {}
        }
        return bred >= 2;
    }
}

module.exports = FarmingSkill;

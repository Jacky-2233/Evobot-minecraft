const { GoalNear } = require('mineflayer-pathfinder').goals;

const TRASH_ITEMS_DEFAULT = ['dirt', 'cobblestone', 'gravel', 'sand', 'rotten_flesh', 'stick'];

class InventorySkill {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
    }

    items() {
        return this.bot.inventory.items();
    }

    count(itemName) {
        return this.items()
            .filter(i => i.name.includes(itemName))
            .reduce((sum, i) => sum + i.count, 0);
    }

    has(itemName, count = 1) {
        return this.count(itemName) >= count;
    }

    find(itemName) {
        return this.items().find(i => i.name === itemName || i.name.includes(itemName));
    }

    async dropTrash(trashList = null) {
        const trash = trashList || this.agent.config.bot.trashItems || TRASH_ITEMS_DEFAULT;
        let dropped = 0;
        for (const item of this.items()) {
            if (trash.some(t => item.name.includes(t))) {
                try {
                    await this.bot.tossStack(item);
                    dropped++;
                } catch (e) {
                    this.agent.log('[Inventory] Drop failed:', e.message);
                }
            }
        }
        if (dropped > 0) this.agent.log(`[Inventory] Dropped ${dropped} trash items`);
        return dropped;
    }

    async equipBestTool(block) {
        if (!block) return;
        const tool = this.findBestToolForBlock(block);
        if (tool) {
            await this.bot.equip(tool, 'hand').catch(() => {});
        }
    }

    findBestToolForBlock(block) {
        const harvestTools = {
            'pickaxe': ['stone', 'iron_ore', 'coal_ore', 'diamond_ore', 'gold_ore', 'copper_ore', 'deepslate'],
            'axe': ['log', 'wood', 'stem', 'hyphae', 'planks'],
            'shovel': ['dirt', 'gravel', 'sand', 'clay'],
            'hoe': ['wheat', 'carrots', 'potatoes', 'beetroots'],
        };
        const materials = ['netherite', 'diamond', 'iron', 'stone', 'wooden', 'golden'];

        let bestTool = null;
        let bestScore = -1;

        for (const [toolType, blocks] of Object.entries(harvestTools)) {
            if (blocks.some(b => block.name.includes(b))) {
                for (let i = 0; i < materials.length; i++) {
                    const toolName = `${materials[i]}_${toolType}`;
                    const tool = this.find(toolName);
                    if (tool) {
                        const score = materials.length - i;
                        if (score > bestScore) {
                            bestScore = score;
                            bestTool = tool;
                        }
                    }
                }
            }
        }
        return bestTool;
    }

    async craft(itemName, count = 1) {
        const itemId = this.bot.registry.itemsByName[itemName]?.id;
        if (!itemId) {
            this.agent.log(`[Inventory] Unknown item: ${itemName}`);
            return false;
        }
        const recipes = this.bot.recipesFor(itemId, null, 1, null);
        if (!recipes || recipes.length === 0) {
            this.agent.log(`[Inventory] No recipe for ${itemName}`);
            return false;
        }
        try {
            await this.bot.craft(recipes[0], count);
            this.agent.log(`[Inventory] Crafted ${count} ${itemName}`);
            return true;
        } catch (e) {
            this.agent.log(`[Inventory] Craft ${itemName} failed:`, e.message);
            return false;
        }
    }

    async ensureCraftingTable() {
        if (this.has('crafting_table')) return true;
        if (this.count('planks') >= 4) {
            return await this.craft('crafting_table', 1);
        }
        return false;
    }

    getStatus() {
        return {
            slotsUsed: this.items().length,
            emptySlots: this.bot.inventory.emptySlotCount(),
            items: this.items().map(i => ({ name: i.name, count: i.count })),
        };
    }
}

module.exports = InventorySkill;

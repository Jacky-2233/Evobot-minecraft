import type { SkillMeta, SkillParam } from '../types/index.js';
import type { Executor } from '../executor/executor.js';

export class SkillLibrary {
    private _skills = new Map<string, SkillMeta>();

    constructor(executor: Executor) {
        this.registerBuiltins(executor);
    }

    private registerBuiltins(executor: Executor): void {
        this.register({
            name: 'move_to',
            description: 'Walk to specific coordinates. Use for exploration, approaching targets, escaping.',
            inputParams: [
                { name: 'x', type: 'number', description: 'Target X coordinate', required: true },
                { name: 'y', type: 'number', description: 'Target Y coordinate (feet level)', required: true },
                { name: 'z', type: 'number', description: 'Target Z coordinate', required: true },
                { name: 'reachDistance', type: 'number', description: 'How close to get (default 2)', default: 2 },
            ],
            preconditions: ['Position must be valid (not NaN)', 'Pathfinder must be available'],
            successCondition: 'Bot reaches within reachDistance of target coordinates',
            failReasons: ['Path blocked by terrain', 'Target in unreachable location', 'Timeout', 'Disconnected', 'Position became NaN'],
            tags: ['movement', 'core'],
            complexity: 1,
            dependsOn: [],
        });

        this.register({
            name: 'collect',
            description: 'Mine and collect a specific block type. Target name can be partial (e.g. "log", "stone", "coal_ore").',
            inputParams: [
                { name: 'target', type: 'string', description: 'Block name to collect (partial match)', required: true },
                { name: 'count', type: 'number', description: 'How many to collect (default 1)', default: 1 },
                { name: 'maxDistance', type: 'number', description: 'Search radius in blocks (default 10)', default: 10 },
            ],
            preconditions: ['Target block type exists within maxDistance', 'Bot can path to the block'],
            successCondition: 'Specified number of blocks are broken and collected in inventory',
            failReasons: ['Block not found in range', 'Cannot reach block', 'Wrong tool (e.g. need pickaxe for stone)', 'Timeout', 'Block not breakable'],
            tags: ['gathering', 'core'],
            complexity: 2,
            dependsOn: ['move_to'],
        });

        this.register({
            name: 'eat',
            description: 'Consume food from inventory to restore hunger. Use when food level is low.',
            inputParams: [],
            preconditions: ['Edible food exists in inventory'],
            successCondition: 'Food consumed, hunger level increased',
            failReasons: ['No food in inventory', 'Eating interrupted'],
            tags: ['survival', 'core'],
            complexity: 1,
            dependsOn: [],
        });

        this.register({
            name: 'retreat',
            description: 'Run away from the nearest hostile mob. Use when health is low or being attacked.',
            inputParams: [
                { name: 'distance', type: 'number', description: 'How far to retreat in blocks (default 16)', default: 16 },
            ],
            preconditions: ['Hostile mob detected nearby'],
            successCondition: 'Bot is at least `distance` blocks away from all hostiles',
            failReasons: ['No safe path', 'Surrounded by hostiles', 'Already safe'],
            tags: ['survival', 'combat', 'core'],
            complexity: 1,
            dependsOn: ['move_to'],
        });

        this.register({
            name: 'craft',
            description: 'Craft items from inventory materials. Supports basic recipes.',
            inputParams: [
                { name: 'item', type: 'string', description: 'Item to craft (planks, stick, crafting_table, wooden_pickaxe, stone_pickaxe, furnace, wooden_sword, stone_sword)', required: true },
                { name: 'count', type: 'number', description: 'How many to craft (default 1)', default: 1 },
            ],
            preconditions: ['Required materials in inventory', 'Crafting table needed for 3x3 recipes (pickaxe, furnace, sword)'],
            successCondition: 'Crafted item appears in inventory',
            failReasons: ['Missing materials', 'Crafting table required but not placed', 'Unknown recipe', 'Crafting interrupted'],
            tags: ['crafting', 'tool', 'progression'],
            complexity: 3,
            dependsOn: ['move_to'],
        });

        this.register({
            name: 'pickup',
            description: 'Scan for and pick up nearby dropped items.',
            inputParams: [
                { name: 'scanRadius', type: 'number', description: 'Search radius in blocks (default 8)', default: 8 },
                { name: 'maxItems', type: 'number', description: 'Max items to pick up (default 3)', default: 3 },
            ],
            preconditions: ['Dropped items exist within scanRadius', 'Inventory has free space'],
            successCondition: 'Nearby dropped items are in inventory',
            failReasons: ['No items nearby', 'Inventory full', 'Items despawned before pickup'],
            tags: ['gathering', 'utility'],
            complexity: 1,
            dependsOn: ['move_to'],
        });
    }

    register(meta: SkillMeta): void {
        this._skills.set(meta.name, meta);
    }

    get(name: string): SkillMeta | undefined {
        return this._skills.get(name);
    }

    getAll(): SkillMeta[] {
        return Array.from(this._skills.values());
    }

    getByTag(tag: string): SkillMeta[] {
        return this.getAll().filter(s => s.tags.includes(tag));
    }

    getByComplexity(max: number): SkillMeta[] {
        return this.getAll().filter(s => s.complexity <= max);
    }

    getAvailable(inventorySummary: string[], recentFailures: string[]): SkillMeta[] {
        return this.getAll().filter(s => {
            if (s.name === 'eat') {
                const hasFood = inventorySummary.some(i =>
                    ['cooked', 'steak', 'porkchop', 'bread', 'apple', 'potato', 'carrot', 'mutton', 'chicken', 'beef', 'rabbit', 'salmon', 'cod'].some(f => i.includes(f))
                );
                if (!hasFood) return false;
            }
            return true;
        });
    }

    toPromptBlock(): string {
        return this.getAll().map(s => {
            const params = s.inputParams.map(p => `${p.name}:${p.type}${p.required ? '' : '?'}`).join(', ');
            return `- ${s.name}(${params}): ${s.description} [${s.tags.join(', ')}]`;
        }).join('\n');
    }

    count(): number { return this._skills.size; }
}

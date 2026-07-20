export type SubgoalTask = { type: string; params: any };
export type InventoryCounts = Record<string, number>;

function count(inv: InventoryCounts, name: string): number {
    return Object.entries(inv).reduce((sum, [item, qty]) => sum + (item.includes(name) ? qty : 0), 0);
}

function ensureTask(tasks: SubgoalTask[], condition: boolean, task: SubgoalTask): void {
    if (!condition) tasks.push(task);
}

export function buildSubgoalPlan(goal: string, inventory: InventoryCounts): SubgoalTask[] | null {
    const tasks: SubgoalTask[] = [];
    const logs = count(inventory, 'log');
    const planks = count(inventory, 'planks');
    const sticks = count(inventory, 'stick');
    const table = count(inventory, 'crafting_table');
    const woodenPickaxe = count(inventory, 'wooden_pickaxe');
    const stone = count(inventory, 'cobblestone') + count(inventory, 'stone');

    switch (goal) {
        case 'crafting_table': {
            ensureTask(tasks, planks >= 4 || logs >= 1, { type: 'collect', params: { target: 'log', count: 1, maxDistance: 24 } });
            ensureTask(tasks, planks >= 4, { type: 'craft', params: { item: 'planks', count: Math.max(1, Math.ceil((4 - planks) / 4)) } });
            ensureTask(tasks, table >= 1, { type: 'craft', params: { item: 'crafting_table', count: 1 } });
            return tasks;
        }
        case 'wooden_pickaxe': {
            ensureTask(tasks, planks >= 5 || logs >= 2, { type: 'collect', params: { target: 'log', count: Math.max(2 - logs, 1), maxDistance: 24 } });
            ensureTask(tasks, planks >= 5, { type: 'craft', params: { item: 'planks', count: Math.max(1, Math.ceil((5 - planks) / 4)) } });
            ensureTask(tasks, sticks >= 2, { type: 'craft', params: { item: 'stick', count: 1 } });
            ensureTask(tasks, table >= 1, { type: 'craft', params: { item: 'crafting_table', count: 1 } });
            ensureTask(tasks, woodenPickaxe >= 1, { type: 'craft', params: { item: 'wooden_pickaxe', count: 1 } });
            return tasks;
        }
        case 'stone_pickaxe': {
            ensureTask(tasks, woodenPickaxe >= 1, { type: 'craft_chain', params: { item: 'wooden_pickaxe' } });
            ensureTask(tasks, stone >= 3, { type: 'collect', params: { target: 'stone', count: Math.max(3 - stone, 3), maxDistance: 24 } });
            ensureTask(tasks, sticks >= 2, { type: 'craft_chain', params: { item: 'wooden_pickaxe' } });
            ensureTask(tasks, table >= 1, { type: 'craft', params: { item: 'crafting_table', count: 1 } });
            ensureTask(tasks, count(inventory, 'stone_pickaxe') >= 1, { type: 'craft', params: { item: 'stone_pickaxe', count: 1 } });
            return tasks;
        }
        case 'furnace': {
            ensureTask(tasks, woodenPickaxe >= 1, { type: 'craft_chain', params: { item: 'wooden_pickaxe' } });
            ensureTask(tasks, stone >= 8, { type: 'collect', params: { target: 'stone', count: Math.max(8 - stone, 8), maxDistance: 24 } });
            ensureTask(tasks, count(inventory, 'furnace') >= 1, { type: 'craft', params: { item: 'furnace', count: 1 } });
            return tasks;
        }
        default:
            return null;
    }
}

import type { Bot } from 'mineflayer';

const LOW_VALUE_ITEMS = ['dirt', 'cobblestone', 'stone', 'gravel', 'sand', 'granite', 'diorite', 'andesite', 'netherrack'];

export class InventoryManager {
    private bot: Bot;
    private _lastAutoToss = 0;

    constructor(bot: Bot) {
        this.bot = bot;
    }

    /** Free slots in inventory (excludes hotbar if full) */
    get freeSlots(): number {
        return this.bot.inventory.emptySlotCount();
    }

    /** Total item count */
    get totalItems(): number {
        return this.bot.inventory.items().reduce((s, i) => s + (i?.count ?? 0), 0);
    }

    /** Summarize inventory as a string */
    summary(): string {
        const items = this.bot.inventory.items().filter(Boolean);
        if (items.length === 0) return '(empty)';
        const groups = new Map<string, number>();
        for (const item of items) {
            const name = (item as any).name ?? `id:${item.type}`;
            groups.set(name, (groups.get(name) ?? 0) + item.count);
        }
        return Array.from(groups.entries())
            .map(([n, c]) => `${n} x${c}`)
            .sort()
            .join(', ');
    }

    /** Group items by name with their slot info */
    grouped(): Array<{ name: string; count: number; maxStack: number; slots: number[] }> {
        const map = new Map<string, { name: string; count: number; maxStack: number; slots: number[] }>();
        for (const item of this.bot.inventory.items()) {
            if (!item) continue;
            const name = (item as any).name ?? `id:${item.type}`;
            const existing = map.get(name);
            const entry = existing ?? { name, count: 0, maxStack: 0, slots: [] as number[] };
            entry.count += item.count;
            entry.maxStack = Math.max(entry.maxStack, item.count);
            entry.slots.push((item as any).slot as number);
            if (!existing) map.set(name, entry);
        }
        return Array.from(map.values());
    }

    /** Consolidate partial stacks of the same item */
    async consolidate(): Promise<number> {
        const groups = this.grouped();
        let moved = 0;
        for (const group of groups) {
            const maxStack = group.maxStack;
            if (group.count <= maxStack || group.slots.length <= 1) continue;
            const items = group.slots
                .map(s => this.bot.inventory.items().find(i => i?.slot === s))
                .filter(Boolean);
            for (let i = 1; i < items.length; i++) {
                const src = items[i];
                const dst = items[0];
                if (!src || !dst) continue;
                if (dst.count >= maxStack) break;
                try {
                    await this.bot.moveSlotItem(src.slot, dst.slot);
                    moved++;
                } catch {}
            }
        }
        return moved;
    }

    /** Auto-toss low-value items when inventory is too full */
    async autoToss(minFreeSlots = 5): Promise<number> {
        const now = Date.now();
        if (now - this._lastAutoToss < 10000) return 0;
        this._lastAutoToss = now;

        if (this.freeSlots >= minFreeSlots) return 0;

        const items = this.bot.inventory.items().filter(Boolean);
        const tossable = items
            .filter(i => LOW_VALUE_ITEMS.some(lv => (i as any).name?.includes(lv)))
            .sort((a, b) => b.count - a.count);

        let tossed = 0;
        for (const item of tossable) {
            if (this.freeSlots >= minFreeSlots) break;
            const toToss = Math.min(item.count, 64);
            try {
                await this.bot.toss(item.type, toToss, item.metadata);
                tossed += toToss;
            } catch {}
        }
        return tossed;
    }

    /** Check if we have a specific item */
    hasItem(name: string, minCount = 1): boolean {
        let total = 0;
        for (const item of this.bot.inventory.items()) {
            if (!item) continue;
            if (((item as any).name ?? '').includes(name)) {
                total += item.count;
                if (total >= minCount) return true;
            }
        }
        return false;
    }

    /** Count a specific item */
    countItem(name: string): number {
        return this.bot.inventory.items().reduce((s, i) => {
            if (!i) return s;
            return ((i as any).name ?? '').includes(name) ? s + i.count : s;
        }, 0);
    }
}

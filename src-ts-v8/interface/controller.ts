import type { BotConfig } from "../../src-ts-v7/types/index.js";
import { McApiBackendApi, type McApiState } from "../api/mc-api.js";

export type MoveResult = { ok: boolean; detail: string; failureType?: "stuck" | "blocked" | "timeout" | "cancelled" };
export type CollectResult = { ok: boolean; detail: string; failureType?: "no_target" | "timeout" | "cancelled" };

export class McController {
    private readonly api: McApiBackendApi;
    private readonly config: BotConfig;
    private state: McApiState | null = null;
    private lastEvent = "none";
    private currentMoveTarget: { x: number; y: number; z: number; reachDistance: number } | null = null;
    private moveAbort = false;

    constructor(config: BotConfig, baseUrl = "http://127.0.0.1:38888") {
        this.config = config;
        this.api = new McApiBackendApi(baseUrl);
    }

    async refreshState(): Promise<McApiState | null> {
        try {
            this.state = await this.api.getState();
            return this.state;
        } catch (e) {
            this.lastEvent = `mc-api refresh failed: ${(e as Error).message}`;
            console.error("[v8] refresh failed:", (e as Error).message);
            return null;
        }
    }

    getStateSnapshot(): McApiState | null { return this.state; }
    getLastEvent(): string { return this.lastEvent; }
    getCurrentMoveTarget(): { x: number; y: number; z: number; reachDistance: number } | null { return this.currentMoveTarget; }

    async chat(message: string): Promise<void> {
        await this.api.chat(message);
        this.lastEvent = `chat -> ${message}`;
    }

    async tap(key: string): Promise<void> {
        await this.api.setKey(key, true);
        await this.sleep(80);
        await this.api.setKey(key, false);
        this.lastEvent = `tap ${key}`;
    }

    async hold(key: string, ms: number): Promise<void> {
        await this.api.setKey(key, true);
        await this.sleep(ms);
        await this.api.setKey(key, false);
        this.lastEvent = `hold ${key} ${ms}ms`;
    }

    async stopInputs(): Promise<void> {
        await this.api.stopAll();
        this.lastEvent = "stop_all inputs";
    }

    async look(yaw: number, pitch: number): Promise<void> {
        await this.api.look(yaw, pitch);
        this.lastEvent = `look yaw=${yaw} pitch=${pitch}`;
        await this.refreshState();
    }

    async selectHotbar(slot: number): Promise<void> {
        await this.api.selectHotbar(slot);
        this.lastEvent = `hotbar slot=${slot}`;
        await this.refreshState();
    }

    async getRaycastSummary(): Promise<string> {
        const hit = await this.api.getRaycast();
        if (hit.missed) return "Raycast: miss";
        return `Raycast: ${hit.hitType} ${hit.name ?? "(unknown)"} @ (${hit.x.toFixed(1)}, ${hit.y.toFixed(1)}, ${hit.z.toFixed(1)}) dist=${hit.distance.toFixed(2)}`;
    }

    // ========== Obstacle-aware moveTo ==========
    async moveTo(x: number, y: number, z: number, reachDistance = 2): Promise<MoveResult> {
        this.moveAbort = false;
        this.currentMoveTarget = { x, y, z, reachDistance };
        this.lastEvent = `move_to -> (${x}, ${y}, ${z})`;
        await this.api.stopAll();

        const startedAt = Date.now();
        let lastPosSnapshot: { x: number; y: number; z: number } | null = null;
        let stuckDuration = 0;

        while (!this.moveAbort && Date.now() - startedAt < (this.config.stuckTimeoutMs || 30000)) {
            const s = await this.refreshState();
            if (!s?.inGame) {
                await this.api.stopAll();
                this.currentMoveTarget = null;
                return { ok: false, detail: "Not in game", failureType: "cancelled" };
            }

            const fullDist = Math.sqrt((x - s.x) ** 2 + (y - s.y) ** 2 + (z - s.z) ** 2);
            if (fullDist <= Math.max(reachDistance, 2)) {
                await this.api.stopAll();
                this.currentMoveTarget = null;
                this.lastEvent = `move_to arrived (${x}, ${y}, ${z}) dist=${fullDist.toFixed(2)}`;
                return { ok: true, detail: `Arrived at (${x}, ${y}, ${z})` };
            }

            // Obstacle detection via stuck checking
            if (lastPosSnapshot) {
                const moved = Math.sqrt(
                    (s.x - lastPosSnapshot.x) ** 2 +
                    (s.y - lastPosSnapshot.y) ** 2 +
                    (s.z - lastPosSnapshot.z) ** 2
                );
                if (moved < 0.2) {
                    stuckDuration += 120;
                    if (stuckDuration > 3000 && stuckDuration < 3200) {
                        // Try jumping over obstacle
                        await this.api.setKey("space", true);
                        await this.sleep(150);
                        await this.api.setKey("space", false);
                    }
                    if (stuckDuration > 15000) {
                        await this.api.stopAll();
                        this.currentMoveTarget = null;
                        this.lastEvent = `move_to stuck -> (${x}, ${y}, ${z})`;
                        return { ok: false, detail: "Stuck on obstacle", failureType: "stuck" };
                    }
                } else {
                    stuckDuration = 0;
                }
            }
            lastPosSnapshot = { x: s.x, y: s.y, z: s.z };

            const horizontal = Math.sqrt((x - s.x) ** 2 + (z - s.z) ** 2);
            const targetYaw = this.computeYawTo(s.x, s.z, x, z);
            const targetPitch = this.computePitchTo(s.x, s.y, s.z, x, y, z);
            const yawDiff = this.wrapDegrees(targetYaw - s.yaw);
            await this.api.look(targetYaw, targetPitch);

            if (Math.abs(yawDiff) > 20) {
                await this.api.stopAll();
                await this.sleep(80);
                continue;
            }

            await this.api.setKey("w", true);
            if (horizontal > 8) await this.api.setKey("sprint", true);
            else await this.api.setKey("sprint", false);
            await this.sleep(120);
        }

        await this.api.stopAll();
        const detail = this.moveAbort ? "move_to aborted" : `move_to timeout -> (${x}, ${y}, ${z})`;
        this.lastEvent = detail;
        this.currentMoveTarget = null;
        return this.moveAbort
            ? { ok: false, detail, failureType: "cancelled" }
            : { ok: false, detail, failureType: "timeout" };
    }

    // ========== Block breaking (CollectSkill equivalent) ==========
    async breakBlock(target: string, maxDistance = 5, timeoutMs = 10000): Promise<CollectResult> {
        this.lastEvent = `break_block -> ${target}`;
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            const s = await this.refreshState();
            if (!s?.inGame) return { ok: false, detail: "Not in game", failureType: "cancelled" };

            const block = (s.nearbyBlocks || []).find(
                (b) => b.blockId.includes(target) || b.name.toLowerCase().includes(target.toLowerCase())
            );
            if (!block) return { ok: false, detail: `No ${target} nearby`, failureType: "no_target" };

            const dist = Math.sqrt((block.x - s.x) ** 2 + (block.y - s.y) ** 2 + (block.z - s.z) ** 2);
            if (dist > maxDistance) {
                const approachResult = await this.moveTo(
                    Math.round(block.x), Math.round(block.y), Math.round(block.z), 2
                );
                if (!approachResult.ok) {
                    return { ok: false, detail: `Cannot reach ${target}: ${approachResult.detail}`, failureType: "no_target" };
                }
                continue;
            }
            const native = await this.api.breakBlock(timeoutMs, { x: block.x, y: block.y, z: block.z });
            if (native.ok) {
                this.lastEvent = `break_block done(native): ${target}`;
                return { ok: true, detail: native.detail };
            }
        }

        return { ok: false, detail: `Timed out breaking ${target}`, failureType: "timeout" };
    }

    // ========== Inventory helpers ==========
    findInInventory(itemId: string): { slot: number; count: number; name: string } | null {
        const s = this.state;
        if (!s?.inGame) return null;
        const target = itemId.toLowerCase();
        for (const item of s.inventory || []) {
            if (item.empty) continue;
            if (item.itemId.toLowerCase().includes(target) || item.name.toLowerCase().includes(target)) {
                return { slot: item.slot, count: item.count, name: item.name };
            }
        }
        return null;
    }

    countInInventory(itemId: string): number {
        const s = this.state;
        if (!s?.inGame) return 0;
        const target = itemId.toLowerCase();
        let total = 0;
        for (const item of s.inventory || []) {
            if (item.empty) continue;
            if (item.itemId.toLowerCase().includes(target) || item.name.toLowerCase().includes(target)) {
                total += item.count;
            }
        }
        return total;
    }

    getSelectedItem(): { itemId: string; name: string; count: number } | null {
        const s = this.state;
        if (!s?.inGame) return null;
        const slot = s.selectedSlot;
        if (slot == null || slot < 0) return null;
        const item = (s.inventory || [])[slot];
        if (!item || item.empty) return null;
        return { itemId: item.itemId, name: item.name, count: item.count };
    }

    // ========== Entity attack ==========
    async attackEntity(targetName: string, maxDistance = 5, timeoutMs = 8000): Promise<CollectResult> {
        this.lastEvent = `attack_entity -> ${targetName}`;
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            const s = await this.refreshState();
            if (!s?.inGame) return { ok: false, detail: "Not in game", failureType: "cancelled" };

            const entity = (s.nearbyEntities || []).find(
                (e) => e.name.toLowerCase().includes(targetName.toLowerCase()) && e.alive
            );
            if (!entity) return { ok: false, detail: `No ${targetName} nearby`, failureType: "no_target" };

            const dist = Math.sqrt((entity.x - s.x) ** 2 + (entity.y - s.y) ** 2 + (entity.z - s.z) ** 2);
            if (dist > maxDistance) {
                const approachResult = await this.moveTo(
                    Math.round(entity.x), Math.round(entity.y), Math.round(entity.z), 2
                );
                if (!approachResult.ok) return { ok: false, detail: `Cannot reach ${targetName}`, failureType: "no_target" };
                continue;
            }

            await this.api.look(
                this.computeYawTo(s.x, s.z, entity.x, entity.z),
                this.computePitchTo(s.x, s.y + 1.5, s.z, entity.x, entity.y + 1, entity.z)
            );
            await this.api.setKey("left_mouse", true);
            await this.sleep(400);
            await this.api.setKey("left_mouse", false);

            const checkState = await this.api.getState();
            const stillAlive = (checkState.nearbyEntities || []).find(
                (e) => e.name.toLowerCase().includes(targetName.toLowerCase()) && e.alive
            );
            if (!stillAlive) {
                this.lastEvent = `attack_entity done: ${targetName}`;
                return { ok: true, detail: `Defeated ${targetName}` };
            }
        }

        return { ok: false, detail: `Timed out attacking ${targetName}`, failureType: "timeout" };
    }

    // ========== Eat ==========
    async eat(): Promise<{ ok: boolean; detail: string }> {
        const s = this.state;
        if (!s?.inGame) return { ok: false, detail: "Not in game" };
        if (s.foodLevel >= 20) return { ok: true, detail: "Already full" };

        const foodNames = [
            "cooked_beef", "cooked_porkchop", "cooked_mutton", "cooked_chicken",
            "beef", "porkchop", "mutton", "chicken", "bread", "apple", "golden_apple",
            "baked_potato", "carrot", "potato", "cod", "salmon", "cooked_cod", "cooked_salmon",
        ];

        let foodSlot = -1;
        for (const food of foodNames) {
            const found = this.findInInventory(food);
            if (found && found.slot >= 0 && found.slot <= 8) {
                foodSlot = found.slot;
                break;
            }
        }

        if (foodSlot < 0) return { ok: false, detail: "No food in hotbar" };

        await this.selectHotbar(foodSlot);
        await this.sleep(100);
        await this.api.setKey("right_mouse", true);
        await this.sleep(2000);
        await this.api.setKey("right_mouse", false);

        const afterState = await this.api.getState();
        if ((afterState.foodLevel ?? s.foodLevel) > s.foodLevel) {
            return { ok: true, detail: "Ate food" };
        }
        return { ok: true, detail: "Eating attempted" };
    }

    abortAll(): void {
        this.moveAbort = true;
        void this.stopInputs();
    }

    private computeYawTo(x: number, z: number, tx: number, tz: number): number {
        return Math.atan2(tz - z, tx - x) * 180 / Math.PI - 90;
    }

    private computePitchTo(x: number, y: number, z: number, tx: number, ty: number, tz: number): number {
        const dx = tx - x;
        const dy = ty - y;
        const dz = tz - z;
        const horizontal = Math.sqrt(dx * dx + dz * dz);
        return -Math.atan2(dy, horizontal) * 180 / Math.PI;
    }

    private wrapDegrees(value: number): number {
        let out = value % 360;
        if (out >= 180) out -= 360;
        if (out < -180) out += 360;
        return out;
    }

    sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ========== Crafting ==========
    async craftRecipe(itemId: string, makeAll = false): Promise<{ ok: boolean; detail: string }> {
        try {
            const result = await this.api.craft(itemId, makeAll);
            this.lastEvent = "craftRecipe: " + itemId;
            return { ok: result.ok, detail: result.detail };
        } catch (e) {
            return { ok: false, detail: "Craft failed: " + (e as Error).message };
        }
    }

    async placeBlock(itemName: string): Promise<{ ok: boolean; detail: string }> {
        // Find block in inventory and select it
        const found = this.findInInventory(itemName);
        if (!found) return { ok: false, detail: "No " + itemName + " in inventory" };

        if (found.slot >= 0 && found.slot <= 8) {
            await this.selectHotbar(found.slot);
        } else {
            // Need to move from inventory to hotbar - click the slot to pick up, then click hotbar slot
            await this.api.setKey("e", true);
            await this.sleep(200);
            await this.api.setKey("e", false);
            await this.sleep(300);
            // Click the item slot to pick it up
            await this.api.clickSlot(found.slot, 0, "PICKUP");
            await this.sleep(100);
            // Click hotbar slot to place it
            const s = this.state;
            const targetHotbar = s ? 36 + s.selectedSlot : 36;
            await this.api.clickSlot(targetHotbar, 0, "PICKUP");
            await this.sleep(100);
            await this.api.setKey("e", true);
            await this.sleep(100);
            await this.api.setKey("e", false);
        }

        // Right click to place
        await this.api.setKey("right_mouse", true);
        await this.sleep(200);
        await this.api.setKey("right_mouse", false);
        this.lastEvent = "placeBlock: " + itemName;
        return { ok: true, detail: "Placed " + itemName };
    }

    async openBlock(blockName: string): Promise<{ ok: boolean; detail: string }> {
        const s = this.state;
        if (!s) return { ok: false, detail: "No state" };

        // Find the block nearby
        const block = (s.nearbyBlocks || []).find(
            (b) => b.blockId.includes(blockName) || b.name.toLowerCase().includes(blockName.toLowerCase())
        );
        if (!block) return { ok: false, detail: "No " + blockName + " nearby" };

        // Face it
        const targetYaw = this.computeYawTo(s.x, s.z, block.x + 0.5, block.z + 0.5);
        const targetPitch = this.computePitchTo(s.x, s.y + 1.5, s.z, block.x + 0.5, block.y + 0.5, block.z + 0.5);
        await this.api.look(targetYaw, targetPitch);
        await this.sleep(100);

        // Right click to open
        await this.api.setKey("right_mouse", true);
        await this.sleep(200);
        await this.api.setKey("right_mouse", false);
        await this.sleep(300);
        this.lastEvent = "openBlock: " + blockName;
        return { ok: true, detail: "Opened " + blockName };
    }

    // ========== Chat polling ==========
    async getChatHistory(count = 20): Promise<Array<{ username: string; message: string; timestamp: number }>> {
        try {
            return await this.api.getChatHistory(count);
        } catch {
            return [];
        }
    }

    // ========== Native mc-api action delegates ==========
    async breakBlockNative(timeoutMs?: number) { return await this.api.breakBlock(timeoutMs); }
    async attackEntityNative(target: string, timeoutMs?: number) { return await this.api.attackEntity(target, timeoutMs); }
    async moveToNative(x: number, y: number, z: number, reachDistance?: number, timeoutMs?: number) { return await this.api.moveTo(x, y, z, reachDistance, timeoutMs); }
    async pathToNative(x: number, y: number, z: number, timeoutMs?: number) { return await this.api.pathTo(x, y, z, timeoutMs); }
    async useItemNative(holdMs?: number) { return await this.api.useItem(holdMs); }
    async placeBlockNative(x: number, y: number, z: number) { return await this.api.placeBlock(x, y, z); }
    async inventorySummary() { return await this.api.inventorySummary(); }
    async selectItem(name: string) { return await this.api.selectItem(name); }
    async openContainer(x: number, y: number, z: number) { return await this.api.openContainer(x, y, z); }
    async containerItems() { return await this.api.containerItems(); }
    async moveContainerItem(from: number, to: number) { return await this.api.moveContainerItem(from, to); }
    async closeContainer() { return await this.api.closeContainer(); }
    async worldTime() { return await this.api.worldTime(); }

}

export type McApiInventoryItem = {
    slot: number;
    itemId: string;
    count: number;
    name: string;
    empty: boolean;
};

export type McApiNearbyEntity = {
    type: string;
    name: string;
    x: number;
    y: number;
    z: number;
    distance: number;
    health: number;
    alive: boolean;
};

export type McApiNearbyBlock = {
    blockId: string;
    name: string;
    x: number;
    y: number;
    z: number;
    distance: number;
};

export type McApiState = {
    inGame: boolean;
    x: number;
    y: number;
    z: number;
    blockX: number;
    blockY: number;
    blockZ: number;
    yaw: number;
    pitch: number;
    health: number;
    maxHealth: number;
    foodLevel: number;
    armor: number;
    selectedSlot: number;
    gamemode: string;
    inventory: McApiInventoryItem[];
    serverAddress: string | null;
    playerList: Array<{ name: string; uuid: string; latency: number }>;
    nearbyEntities: McApiNearbyEntity[];
    nearbyBlocks: McApiNearbyBlock[];
    keys: Record<string, boolean>;
};

export type McApiRaycast = {
    hitType: string;
    name: string | null;
    x: number;
    y: number;
    z: number;
    distance: number;
    missed: boolean;
};

export type McApiChatMessage = {
    username: string;
    message: string;
    timestamp: number;
};
export class McApiClient {
    constructor(private readonly baseUrl = "http://127.0.0.1:38888") {}

    async getState(): Promise<McApiState> {
        const resp = await fetch(this.baseUrl + "/api/state");
        if (!resp.ok) throw new Error("mc-api state failed: " + resp.status);
        return await resp.json() as McApiState;
    }

    async setKey(key: string, pressed: boolean): Promise<void> {
        const resp = await fetch(this.baseUrl + "/api/input", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, pressed }),
        });
        if (!resp.ok) throw new Error("mc-api input failed: " + resp.status);
    }

    async stopAll(): Promise<void> {
        const resp = await fetch(this.baseUrl + "/api/stop_all", { method: "POST" });
        if (!resp.ok) throw new Error("mc-api stop_all failed: " + resp.status);
    }

    async look(yaw: number, pitch: number): Promise<void> {
        const resp = await fetch(this.baseUrl + "/api/look", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ yaw, pitch }),
        });
        if (!resp.ok) throw new Error("mc-api look failed: " + resp.status);
    }

    async selectHotbar(slot: number): Promise<void> {
        const resp = await fetch(this.baseUrl + "/api/hotbar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slot }),
        });
        if (!resp.ok) throw new Error("mc-api hotbar failed: " + resp.status);
    }

    async getRaycast(): Promise<McApiRaycast> {
        const resp = await fetch(this.baseUrl + "/api/raycast");
        if (!resp.ok) throw new Error("mc-api raycast failed: " + resp.status);
        return await resp.json() as McApiRaycast;
    }

    async chat(message: string): Promise<void> {
        const resp = await fetch(this.baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
        });
        if (!resp.ok) throw new Error("mc-api chat failed: " + resp.status);
    }

    async getChatHistory(count = 20): Promise<McApiChatMessage[]> {
        const resp = await fetch(this.baseUrl + "/api/chat/history?count=" + count);
        if (!resp.ok) throw new Error("mc-api chat history failed: " + resp.status);
        return await resp.json() as McApiChatMessage[];
    }

    async clickSlot(slot: number, button = 0, action = "PICKUP"): Promise<void> {
        const resp = await fetch(this.baseUrl + "/api/inventory/click", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slot, button, action }),
        });
        if (!resp.ok) throw new Error("mc-api inventory click failed: " + resp.status);
    }

    async craftRecipe(itemId: string, makeAll = false): Promise<void> {
        const resp = await fetch(this.baseUrl + "/api/craft/recipe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ itemId, makeAll }),
        });
        if (!resp.ok) throw new Error("mc-api craft recipe failed: " + resp.status);
    }

    async breakBlock(timeoutMs = 8000, target?: { x: number; y: number; z: number }): Promise<McApiActionResult> {
        const resp = await fetch(this.baseUrl + "/api/break_block", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(target ? { timeoutMs, x: target.x, y: target.y, z: target.z } : { timeoutMs }),
        });
        if (!resp.ok) throw new Error("mc-api break_block failed: " + resp.status);
        return await resp.json() as McApiActionResult;
    }

    async attackEntity(target: string, timeoutMs = 10000): Promise<McApiActionResult> {
        const resp = await fetch(this.baseUrl + "/api/attack_entity", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target, timeoutMs }),
        });
        if (!resp.ok) throw new Error("mc-api attack_entity failed: " + resp.status);
        return await resp.json() as McApiActionResult;
    }

    async moveTo(x: number, y: number, z: number, reachDistance = 1.5, timeoutMs = 20000): Promise<McApiActionResult> {
        const resp = await fetch(this.baseUrl + "/api/move_to", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x, y, z, reachDistance, timeoutMs }),
        });
        if (!resp.ok) throw new Error("mc-api move_to failed: " + resp.status);
        return await resp.json() as McApiActionResult;
    }

    async useItem(holdMs = 200): Promise<McApiActionResult> {
        const resp = await fetch(this.baseUrl + "/api/use_item", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ holdMs }),
        });
        if (!resp.ok) throw new Error("mc-api use_item failed: " + resp.status);
        return await resp.json() as McApiActionResult;
    }

    async placeBlock(x: number, y: number, z: number): Promise<McApiActionResult> {
        const resp = await fetch(this.baseUrl + "/api/place_block", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x, y, z }),
        });
        if (!resp.ok) throw new Error("mc-api place_block failed: " + resp.status);
        return await resp.json() as McApiActionResult;
    }

    async inventorySummary(): Promise<Record<string, any>> {
        const resp = await fetch(this.baseUrl + "/api/inventory/summary");
        if (!resp.ok) throw new Error("mc-api inventory/summary failed: " + resp.status);
        return await resp.json() as Record<string, any>;
    }

    async selectItem(name: string): Promise<McApiActionResult> {
        const resp = await fetch(this.baseUrl + "/api/select_item", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
        if (!resp.ok) throw new Error("mc-api select_item failed: " + resp.status);
        return await resp.json() as McApiActionResult;
    }

    async openContainer(x: number, y: number, z: number): Promise<McApiActionResult> {
        const resp = await fetch(this.baseUrl + "/api/container/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x, y, z }),
        });
        if (!resp.ok) throw new Error("mc-api container/open failed: " + resp.status);
        return await resp.json() as McApiActionResult;
    }

    async containerItems(): Promise<Record<string, any>> {
        const resp = await fetch(this.baseUrl + "/api/container/items");
        if (!resp.ok) throw new Error("mc-api container/items failed: " + resp.status);
        return await resp.json() as Record<string, any>;
    }

    async moveContainerItem(from: number, to: number): Promise<McApiActionResult> {
        const resp = await fetch(this.baseUrl + "/api/container/move", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from, to }),
        });
        if (!resp.ok) throw new Error("mc-api container/move failed: " + resp.status);
        return await resp.json() as McApiActionResult;
    }

    async closeContainer(): Promise<McApiActionResult> {
        const resp = await fetch(this.baseUrl + "/api/container/close", { method: "POST" });
        if (!resp.ok) throw new Error("mc-api container/close failed: " + resp.status);
        return await resp.json() as McApiActionResult;
    }

    async worldTime(): Promise<Record<string, any>> {
        const resp = await fetch(this.baseUrl + "/api/world/time");
        if (!resp.ok) throw new Error("mc-api world/time failed: " + resp.status);
        return await resp.json() as Record<string, any>;
    }

    async craft(itemId: string, makeAll = false): Promise<McApiActionResult> {
        const resp = await fetch(this.baseUrl + "/api/craft", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ itemId, makeAll }),
        });
        if (!resp.ok) throw new Error("mc-api craft failed: " + resp.status);
        return await resp.json() as McApiActionResult;
    }

    async pathTo(x: number, y: number, z: number, timeoutMs = 30000): Promise<McApiActionResult> {
        const resp = await fetch(this.baseUrl + "/api/path_to", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x, y, z, timeoutMs }),
        });
        if (!resp.ok) throw new Error("mc-api path_to failed: " + resp.status);
        return await resp.json() as McApiActionResult;
    }
}

export type McApiActionResult = {
    ok: boolean;
    detail: string;
    inventoryDelta: Record<string, number>;
    verifier: Record<string, unknown>;
};

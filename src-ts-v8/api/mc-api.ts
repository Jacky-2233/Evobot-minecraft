import { McApiClient, type McApiRaycast, type McApiState, type McApiChatMessage, type McApiActionResult } from "../../src-ts-v7/utils/mc-api-client.js";

export type { McApiState, McApiRaycast, McApiChatMessage, McApiActionResult };

export class McApiBackendApi {
    private readonly client: McApiClient;

    constructor(baseUrl = "http://127.0.0.1:38888") {
        this.client = new McApiClient(baseUrl);
    }

    getState(): Promise<McApiState> { return this.client.getState(); }
    setKey(key: string, pressed: boolean): Promise<void> { return this.client.setKey(key, pressed); }
    stopAll(): Promise<void> { return this.client.stopAll(); }
    look(yaw: number, pitch: number): Promise<void> { return this.client.look(yaw, pitch); }
    selectHotbar(slot: number): Promise<void> { return this.client.selectHotbar(slot); }
    getRaycast(): Promise<McApiRaycast> { return this.client.getRaycast(); }
    chat(message: string): Promise<void> { return this.client.chat(message); }
    getChatHistory(count?: number): Promise<McApiChatMessage[]> { return this.client.getChatHistory(count); }
    clickSlot(slot: number, button?: number, action?: string): Promise<void> { return this.client.clickSlot(slot, button, action); }
    craftRecipe(itemId: string, makeAll?: boolean): Promise<void> { return this.client.craftRecipe(itemId, makeAll); }
    craft(itemId: string, makeAll?: boolean): Promise<McApiActionResult> { return this.client.craft(itemId, makeAll); }
    breakBlock(timeoutMs?: number, target?: { x: number; y: number; z: number }): Promise<McApiActionResult> { return this.client.breakBlock(timeoutMs, target); }
    attackEntity(target: string, timeoutMs?: number): Promise<McApiActionResult> { return this.client.attackEntity(target, timeoutMs); }
    moveTo(x: number, y: number, z: number, reachDistance?: number, timeoutMs?: number): Promise<McApiActionResult> { return this.client.moveTo(x, y, z, reachDistance, timeoutMs); }
    pathTo(x: number, y: number, z: number, timeoutMs?: number): Promise<McApiActionResult> { return this.client.pathTo(x, y, z, timeoutMs); }
    useItem(holdMs?: number): Promise<McApiActionResult> { return this.client.useItem(holdMs); }
    placeBlock(x: number, y: number, z: number): Promise<McApiActionResult> { return this.client.placeBlock(x, y, z); }
    inventorySummary(): Promise<Record<string, any>> { return this.client.inventorySummary(); }
    selectItem(name: string): Promise<McApiActionResult> { return this.client.selectItem(name); }
    openContainer(x: number, y: number, z: number): Promise<McApiActionResult> { return this.client.openContainer(x, y, z); }
    containerItems(): Promise<Record<string, any>> { return this.client.containerItems(); }
    moveContainerItem(from: number, to: number): Promise<McApiActionResult> { return this.client.moveContainerItem(from, to); }
    closeContainer(): Promise<McApiActionResult> { return this.client.closeContainer(); }
    worldTime(): Promise<Record<string, any>> { return this.client.worldTime(); }
}

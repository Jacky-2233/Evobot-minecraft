import { McApiClient, type McApiState } from '../utils/mc-api-client.js';
import { initLLM, callLLM, getModel, getProvider, setModel, setProviderKey, listModels } from '../utils/llm.js';
import type { BotConfig } from '../types/index.js';

export class EvoBotMcApi {
    private readonly api: McApiClient;
    private state: McApiState | null = null;
    private loopTimer: NodeJS.Timeout | null = null;
    private readonly config: BotConfig;

    constructor(config: BotConfig) {
        this.config = config;
        this.api = new McApiClient('http://127.0.0.1:38888');
        initLLM(config);
        void this.start();
    }

    private async start(): Promise<void> {
        await this.refreshState();
        this.schedule();
    }

    private schedule(): void {
        this.loopTimer = setTimeout(async () => {
            await this.refreshState();
            this.schedule();
        }, this.config.updateIntervalMs);
    }

    private async refreshState(): Promise<void> {
        try {
            this.state = await this.api.getState();
        } catch (e) {
            console.error('[mc-api] refresh failed:', (e as Error).message);
        }
    }

    getModel(): string { return getModel(); }
    getProvider(): string { return getProvider(); }
    setModel(name: string): void { setModel(name); }
    setProviderKey(provider: string, key: string): void { setProviderKey(provider, key); }
    listModels(): string { return listModels(); }
    listCraftChains(): string { return 'not available in mc-api backend yet'; }
    queueTask(): void { console.log('[mc-api] queueTask not implemented yet'); }
    replaceWithTask(): void { console.log('[mc-api] replaceWithTask not implemented yet'); }
    followPlayer(): void { console.log('[mc-api] followPlayer not implemented yet'); }
    searchTarget(): void { console.log('[mc-api] searchTarget not implemented yet'); }
    stopAll(): void { console.log('[mc-api] stopAll not implemented yet'); }

    async chat(message: string): Promise<void> {
        await this.api.chat(message);
    }

    getScanSummary(query = '', radius = 24): string {
        const state = this.state;
        if (!state?.inGame) return 'mc-api: not in game';
        const q = query.toLowerCase();
        const players = (state.playerList || []).filter((p) => !q || p.name.toLowerCase().includes(q)).map((p) => p.name).join(', ') || 'none';
        const entities = (state.nearbyEntities || []).filter((e) => e.distance <= radius && (!q || e.name.toLowerCase().includes(q))).map((e) => `${e.name}@(${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.z)}) ${e.distance.toFixed(1)}m`).join(', ') || 'none';
        const blocks = (state.nearbyBlocks || []).filter((b) => b.distance <= radius && (!q || b.name.toLowerCase().includes(q) || b.blockId.toLowerCase().includes(q))).map((b) => `${b.blockId}@(${b.x},${b.y},${b.z}) ${b.distance.toFixed(1)}m`).join(', ') || 'none';
        return [`Players: ${players}`, `Entities: ${entities}`, `Blocks: ${blocks}`].join('\n');
    }

    getPlayersSummary(radius = 48): string {
        const state = this.state;
        if (!state?.inGame) return 'mc-api: not in game';
        const players = state.playerList || [];
        if (players.length === 0) return 'Players: none';
        return ['Players:'].concat(players.map((p) => `- ${p.name} ping=${p.latency}`)).join('\n');
    }

    getEntitiesSummary(radius = 24, limit = 12): string {
        const state = this.state;
        if (!state?.inGame) return 'mc-api: not in game';
        const entities = (state.nearbyEntities || []).filter((e) => e.distance <= radius).slice(0, limit);
        if (entities.length === 0) return 'Entities: none';
        return ['Entities:'].concat(entities.map((e) => `- ${e.name} @ (${Math.round(e.x)}, ${Math.round(e.y)}, ${Math.round(e.z)}) ${e.distance.toFixed(1)}m`)).join('\n');
    }

    getBlocksSummary(radius = 24, limit = 12): string {
        const state = this.state;
        if (!state?.inGame) return 'mc-api: not in game';
        const blocks = (state.nearbyBlocks || []).filter((b) => b.distance <= radius).slice(0, limit);
        if (blocks.length === 0) return 'Blocks: none';
        return ['Blocks:'].concat(blocks.map((b) => `- ${b.blockId} @ (${b.x}, ${b.y}, ${b.z}) ${b.distance.toFixed(1)}m`)).join('\n');
    }

    getTasksSummary(): string {
        return 'mc-api backend: task execution migration is not finished yet';
    }

    getMemorySummary(query = ''): string {
        return `mc-api backend memory summary placeholder\nquery=${query || '(empty)'}`;
    }

    async getWebKnowledgeSummary(query: string): Promise<string> {
        const reply = await callLLM([{ role: 'user', content: `Answer briefly: ${query}` }], { maxTokens: 120, temperature: 0.2 });
        return reply || 'No web knowledge configured';
    }

    getStatusSummary(): string {
        const s = this.state;
        if (!s) return 'mc-api backend: no state yet';
        return [
            `Backend: mc-api`,
            `In game: ${s.inGame}`,
            `Pos: (${s.blockX}, ${s.blockY}, ${s.blockZ})`,
            `Health: ${s.health}/${s.maxHealth}`,
            `Food: ${s.foodLevel}`,
            `Armor: ${s.armor}`,
            `Server: ${s.serverAddress ?? 'unknown'}`,
            `Nearby entities: ${(s.nearbyEntities || []).length}`,
            `Nearby blocks: ${(s.nearbyBlocks || []).length}`,
        ].join('\n');
    }
}

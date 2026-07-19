export type WebKnowledgeResult = {
    source: string;
    text: string;
};

export interface WebKnowledgeProvider {
    query(query: string): Promise<WebKnowledgeResult[]>;
}

export class DisabledWebKnowledgeProvider implements WebKnowledgeProvider {
    async query(): Promise<WebKnowledgeResult[]> {
        return [];
    }
}

export class HttpWebKnowledgeProvider implements WebKnowledgeProvider {
    constructor(private readonly endpoint: string) {}

    async query(query: string): Promise<WebKnowledgeResult[]> {
        if (!this.endpoint) return [];
        const url = `${this.endpoint}${this.endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
        const resp = await fetch(url);
        if (!resp.ok) return [];
        const data = await resp.json() as any;
        if (Array.isArray(data)) return data;
        if (Array.isArray(data.results)) return data.results;
        return [];
    }
}

export function createWebKnowledgeProvider(): WebKnowledgeProvider {
    const endpoint = process.env.EVOBOT_WEB_KNOWLEDGE_URL;
    return endpoint ? new HttpWebKnowledgeProvider(endpoint) : new DisabledWebKnowledgeProvider();
}

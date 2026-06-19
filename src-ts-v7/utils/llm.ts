import OpenAI from 'openai';
import type { BotConfig } from '../types/index.js';

let client: OpenAI | null = null;
let model = '';

export function initLLM(config: BotConfig): void {
    client = new OpenAI({ apiKey: config.ai.apiKey, baseURL: config.ai.baseURL });
    model = config.ai.model;
}

export async function callLLM(messages: { role: string; content: string }[], options?: { maxTokens?: number; temperature?: number }): Promise<string> {
    if (!client) return '';
    try {
        const resp = await client.chat.completions.create({
            model, messages: messages as any,
            max_tokens: options?.maxTokens ?? 200,
            temperature: options?.temperature ?? 0.3,
        });
        return resp.choices?.[0]?.message?.content ?? '';
    } catch { return ''; }
}

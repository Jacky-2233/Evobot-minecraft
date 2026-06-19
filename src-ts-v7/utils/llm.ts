import OpenAI from 'openai';
import type { BotConfig } from '../types/index.js';

let client: OpenAI | null = null;
let _model = '';

export function initLLM(config: BotConfig): void {
    client = new OpenAI({ apiKey: config.ai.apiKey, baseURL: config.ai.baseURL });
    _model = config.ai.model;
}

export function setModel(name: string): void { _model = name; console.log(`[LLM] Model → ${name}`); }
export function getModel(): string { return _model; }

export async function callLLM(messages: { role: string; content: string }[], options?: { maxTokens?: number; temperature?: number }): Promise<string> {
    if (!client) return '';
    try {
        const resp = await client.chat.completions.create({
            model: _model, messages: messages as any,
            max_tokens: options?.maxTokens ?? 200,
            temperature: options?.temperature ?? 0.3,
        });
        return resp.choices?.[0]?.message?.content ?? '';
    } catch { return ''; }
}

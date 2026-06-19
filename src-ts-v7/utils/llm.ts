import OpenAI from 'openai';
import type { BotConfig } from '../types/index.js';

let client: OpenAI | null = null;
let _config: BotConfig | null = null;
let _model = '';

const MODEL_ALIASES: Record<string, { model: string; baseURL: string }> = {
    'kimi-k2.5': { model: 'kimi-k2.5', baseURL: 'https://api.moonshot.cn/v1' },
    'kimi-k2.6': { model: 'kimi-k2.6', baseURL: 'https://api.moonshot.cn/v1' },
    'kimi-k2.7': { model: 'kimi-k2.7-code', baseURL: 'https://api.moonshot.cn/v1' },
    'kimi-k2.7-code': { model: 'kimi-k2.7-code', baseURL: 'https://api.moonshot.cn/v1' },
    'kimi-k2.7-highspeed': { model: 'kimi-k2.7-code-highspeed', baseURL: 'https://api.moonshot.cn/v1' },
    'deepseek-chat': { model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1' },
    'deepseek-reasoner': { model: 'deepseek-reasoner', baseURL: 'https://api.deepseek.com/v1' },
    'deepseek-v4-flash': { model: 'deepseek-v4-flash', baseURL: 'https://api.deepseek.com/v1' },
    'deepseek-v4-pro': { model: 'deepseek-v4-pro', baseURL: 'https://api.deepseek.com/v1' },
};

export function initLLM(config: BotConfig): void {
    _config = config;
    client = new OpenAI({ apiKey: config.ai.apiKey, baseURL: config.ai.baseURL });
    _model = config.ai.model;
}

export function setModel(name: string): void {
    const alias = MODEL_ALIASES[name];
    _model = alias?.model ?? name;
    if (alias && _config) {
        client = new OpenAI({ apiKey: _config.ai.apiKey, baseURL: alias.baseURL });
        console.log(`[LLM] Provider → ${alias.baseURL}`);
    }
    console.log(`[LLM] Model → ${_model}`);
}

export function getModel(): string { return _model; }

export function listModels(): string {
    return Object.keys(MODEL_ALIASES).join(', ');
}

export async function callLLM(messages: { role: string; content: string }[], options?: { maxTokens?: number; temperature?: number }): Promise<string> {
    if (!client) return '';
    try {
        const isKimi = _model.startsWith('kimi-');
        const body: any = {
            model: _model,
            messages: messages as any,
            temperature: options?.temperature ?? 0.3,
        };
        if (isKimi) {
            body.max_completion_tokens = options?.maxTokens ?? 200;
        } else {
            body.max_tokens = options?.maxTokens ?? 200;
        }
        const resp = await client.chat.completions.create(body);
        return resp.choices?.[0]?.message?.content ?? '';
    } catch (e) {
        console.error('[LLM] call failed:', (e as Error).message);
        return '';
    }
}

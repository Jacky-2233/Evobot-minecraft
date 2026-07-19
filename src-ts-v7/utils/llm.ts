import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import type { BotConfig, ProviderConfig } from '../types/index.js';

let client: OpenAI | null = null;
let _config: BotConfig | null = null;
let _model = '';
let _provider = '';

type ModelAliasEntry = { model: string; provider: string; defaultBaseURL: string };

const MODEL_ALIASES: Record<string, ModelAliasEntry> = {
    'kimi-k2.5':             { model: 'kimi-k2.5',            provider: 'kimi',       defaultBaseURL: 'https://api.moonshot.cn/v1' },
    'kimi-k2.6':             { model: 'kimi-k2.6',            provider: 'kimi',       defaultBaseURL: 'https://api.moonshot.cn/v1' },
    'kimi-k2.7':             { model: 'kimi-k2.7-code',       provider: 'kimi',       defaultBaseURL: 'https://api.moonshot.cn/v1' },
    'kimi-k2.7-code':        { model: 'kimi-k2.7-code',       provider: 'kimi',       defaultBaseURL: 'https://api.moonshot.cn/v1' },
    'kimi-k2.7-highspeed':   { model: 'kimi-k2.7-code-highspeed', provider: 'kimi',    defaultBaseURL: 'https://api.moonshot.cn/v1' },
    'deepseek-chat':         { model: 'deepseek-chat',        provider: 'deepseek',   defaultBaseURL: 'https://api.deepseek.com/v1' },
    'deepseek-reasoner':     { model: 'deepseek-reasoner',    provider: 'deepseek',   defaultBaseURL: 'https://api.deepseek.com/v1' },
    'deepseek-v4-flash':     { model: 'deepseek-v4-flash',    provider: 'deepseek',   defaultBaseURL: 'https://api.deepseek.com/v1' },
    'deepseek-v4-pro':       { model: 'deepseek-v4-pro',      provider: 'deepseek',   defaultBaseURL: 'https://api.deepseek.com/v1' },
};

function readKeyFile(fileName: string): string {
    const filePath = path.isAbsolute(fileName) ? fileName : path.join(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8').trim();
}

function resolveProviderKey(providerName: string): { apiKey: string; baseURL: string } {
    if (!_config) return { apiKey: '', baseURL: '' };
    const ai = _config.ai;
    const providerCfg: ProviderConfig | undefined = ai.providers?.[providerName];
    if (providerCfg) {
        const key = (providerCfg.apiKey || '').trim() || (providerCfg.apiKeyFile ? readKeyFile(providerCfg.apiKeyFile) : '');
        const url = providerCfg.baseURL?.trim() || '';
        if (key && url) return { apiKey: key, baseURL: url };
    }
    const alias = MODEL_ALIASES[_model] || MODEL_ALIASES['deepseek-v4-flash'];
    const legacyKey = (ai.apiKey || '').trim();
    return { apiKey: legacyKey, baseURL: alias.defaultBaseURL };
}

function buildClient(providerName: string): void {
    const { apiKey, baseURL } = resolveProviderKey(providerName);
    client = new OpenAI({ apiKey, baseURL });
    _provider = providerName;
    console.log(`[LLM] Provider → ${providerName} | ${baseURL}`);
}

export function initLLM(config: BotConfig): void {
    _config = config;
    const ai = config.ai;
    if (!ai.providers || Object.keys(ai.providers).length === 0) {
        ai.providers = {
            [ai.provider || 'default']: {
                baseURL: ai.baseURL || 'https://api.deepseek.com/v1',
                apiKey: ai.apiKey || '',
            },
        };
    }
    _model = ai.model || 'deepseek-v4-flash';
    const alias = MODEL_ALIASES[_model];
    _provider = alias?.provider || ai.provider || 'default';
    buildClient(_provider);
    console.log(`[LLM] Model → ${_model}`);
}

export function setModel(name: string): void {
    const alias = MODEL_ALIASES[name];
    _model = alias?.model ?? name;
    _provider = alias?.provider ?? _provider;
    buildClient(_provider);
    console.log(`[LLM] Model → ${_model}`);
}

export function getModel(): string { return _model; }

export function getProvider(): string { return _provider; }

export function setProviderKey(providerName: string, apiKey: string): void {
    if (!_config) return;
    const ai = _config.ai;
    if (!ai.providers[providerName]) {
        ai.providers[providerName] = { baseURL: 'https://api.openai.com/v1', apiKey };
    } else {
        ai.providers[providerName].apiKey = apiKey;
    }
    buildClient(_provider);
    console.log(`[LLM] Provider → ${_provider} | key refreshed`);
}

export function listModels(): string {
    return Object.keys(MODEL_ALIASES).join(', ');
}

export async function callLLM(messages: { role: string; content: string }[], options?: { maxTokens?: number; temperature?: number }): Promise<string> {
    if (!client) return '';
    try {
        const body: any = {
            model: _model,
            messages: messages as any,
        };
        if (_provider === 'kimi') {
            body.temperature = 1;
            body.max_completion_tokens = options?.maxTokens ?? 200;
        } else {
            body.temperature = options?.temperature ?? 0.3;
            body.max_tokens = options?.maxTokens ?? 200;
        }
        const resp = await client.chat.completions.create(body);
        return resp.choices?.[0]?.message?.content ?? '';
    } catch (e) {
        console.error('[LLM] call failed:', (e as Error).message);
        return '';
    }
}

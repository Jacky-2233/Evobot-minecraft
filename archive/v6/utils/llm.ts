/**
 * Shared LLM utility for all AI-driven features.
 * Single OpenAI client, shared across chat/planner/behavior.
 */
import type { BotConfig } from '../types/index.js';

let _client: any = null;
let _config: BotConfig | null = null;

/** Initialize the LLM client with bot config */
export function initLLM(config: BotConfig): void {
    _config = config;
    _client = null;
}

/** Call the LLM with a chat completion request */
export async function callLLM(
    messages: { role: string; content: string }[],
    options?: { maxTokens?: number; temperature?: number },
): Promise<string> {
    if (!_config) return '[LLM not initialized]';

    const { OpenAI } = await import('openai');
    if (!_client) {
        _client = new OpenAI({
            apiKey: _config.ai.apiKey,
            baseURL: _config.ai.baseURL,
        });
    }

    const response = await _client.chat.completions.create({
        model: _config.ai.model,
        messages: messages as any,
        max_tokens: options?.maxTokens ?? _config.ai.maxTokens,
        temperature: options?.temperature ?? 0.7,
    });

    return response.choices?.[0]?.message?.content?.trim() ?? '';
}

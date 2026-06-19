import { EvoBotV7 } from './core/bot.js';
import type { BotConfig } from './types/index.js';
import fs from 'fs';
import path from 'path';

function loadConfig(): BotConfig {
    const cfgPath = path.join(process.cwd(), 'config.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    return {
        host: raw.minecraft?.host ?? '127.0.0.1',
        port: raw.minecraft?.port ?? 25565,
        username: raw.minecraft?.username ?? 'EvoBot',
        version: raw.minecraft?.version ?? '1.20.1',
        auth: raw.minecraft?.auth ?? 'offline',
        updateIntervalMs: raw.bot?.updateInterval ?? 1000,
        autoReconnect: raw.bot?.autoReconnect ?? true,
        hungerThreshold: raw.bot?.hungerThreshold ?? 16,
        lowHealthThreshold: raw.bot?.lowHealthThreshold ?? 8,
        criticalHealthThreshold: raw.bot?.criticalHealthThreshold ?? 4,
        stuckTimeoutMs: raw.bot?.stuckTimeoutMs ?? 20000,
        ai: {
            apiKey: raw.ai?.apiKey ?? '',
            baseURL: raw.ai?.baseURL ?? 'https://api.deepseek.com/v1',
            model: raw.ai?.model ?? 'deepseek-v4-flash',
            maxTokens: raw.ai?.maxTokens ?? 200,
            timeoutMs: raw.ai?.replyTimeout ?? 15000,
        },
    };
}

console.log('===========================');
console.log('  EvoBot v7 — AI Driven');
console.log('===========================');

const core = new EvoBotV7(loadConfig());

// Console commands
if (process.stdin.isTTY) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line: string) => {
        const [cmd, ...args] = line.trim().split(/\s+/);
        switch (cmd) {
            case 'say': core.bot?.chat(args.join(' ')); break;
            case 'stop': core.bot?.pathfinder?.stop(); core.bot?.clearControlStates(); break;
            case 'quit': core.bot?.quit(); process.exit(0); break;
            default: console.log('Commands: say, stop, quit');
        }
    });
    rl.setPrompt('[v7] > '); rl.prompt();
    setInterval(() => rl.prompt(), 5000);
}

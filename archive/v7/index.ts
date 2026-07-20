import { EvoBotV7 } from './core/bot.js';
import { EvoBotMcApi } from './core/bot-mc-api.js';
import type { BotConfig } from './types/index.js';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const CONFIG_EXAMPLE_PATH = path.join(process.cwd(), 'config.example.json');

function defaultRawConfig(): any {
    return {
        minecraft: {
            host: '127.0.0.1',
            port: 25565,
            username: 'EvoBot',
            version: '1.20.1',
            auth: 'offline',
        },
        ai: {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            providers: {
                deepseek: {
                    baseURL: 'https://api.deepseek.com/v1',
                    apiKey: '',
                },
                kimi: {
                    baseURL: 'https://api.moonshot.cn/v1',
                    apiKey: '',
                },
                thirdparty: {
                    baseURL: 'https://api.openai.com/v1',
                    apiKey: '',
                },
            },
            maxHistory: 20,
            replyTimeout: 15000,
            maxTokens: 200,
        },
        bot: {
            updateInterval: 300,
            autoReconnect: true,
            hungerThreshold: 16,
            lowHealthThreshold: 8,
            criticalHealthThreshold: 4,
            stuckTimeoutMs: 20000,
        },
    };
}

function loadRawConfig(): any {
    if (fs.existsSync(CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
    if (fs.existsSync(CONFIG_EXAMPLE_PATH)) {
        return JSON.parse(fs.readFileSync(CONFIG_EXAMPLE_PATH, 'utf-8'));
    }
    return defaultRawConfig();
}

function saveRawConfig(raw: any): void {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

function parseServerAddress(value: string, fallbackPort: number): { host: string; port: number } {
    const trimmed = value.trim();
    const match = /^(.+?)(?::(\d+))?$/.exec(trimmed);
    const host = match?.[1]?.trim() || '127.0.0.1';
    const port = Number(match?.[2] || fallbackPort) || fallbackPort;
    return { host, port };
}

function loadConfig(raw: any): BotConfig {
    const ai = raw.ai || {};
    if (!ai.providers || Object.keys(ai.providers).length === 0) {
        ai.providers = {
            default: {
                baseURL: ai.baseURL || 'https://api.deepseek.com/v1',
                apiKey: (ai.apiKey || '').trim() || readLegacyApiKeyFromFile(raw),
            },
        };
    }
    return {
        backend: raw.minecraft?.backend ?? 'mineflayer',
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
            provider: ai.provider || 'default',
            model: ai.model || 'deepseek-v4-flash',
            maxTokens: ai.maxTokens ?? 200,
            timeoutMs: ai.replyTimeout ?? 15000,
            providers: ai.providers,
            apiKey: ai.apiKey,
            baseURL: ai.baseURL,
        },
    };
}

function readLegacyApiKeyFromFile(raw: any): string {
    const fileName = raw.ai?.apiKeyFile;
    if (!fileName || typeof fileName !== 'string') return '';
    const filePath = path.isAbsolute(fileName) ? fileName : path.join(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8').trim();
}

function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
    return new Promise((resolve) => rl.question(prompt, resolve));
}

async function ensurePortableConfig(raw: any): Promise<any> {
    const configExists = fs.existsSync(CONFIG_PATH);
    const providers = raw.ai?.providers || {};
    const hasAnyKey = Object.values(providers).some((p: any) => (p?.apiKey || '').trim());
    if (!configExists || !hasAnyKey) {
        return runInteractiveSetup(raw, false);
    }
    return raw;
}

function saveProviderKey(provider: string, key: string, raw: any): void {
    if (!raw.ai) raw.ai = {};
    if (!raw.ai.providers) raw.ai.providers = {};
    raw.ai.providers[provider] = {
        baseURL: raw.ai.providers[provider]?.baseURL || 'https://api.openai.com/v1',
        apiKey: key,
    };
    saveRawConfig(raw);
}

async function runInteractiveSetup(raw: any, force: boolean): Promise<any> {
    const configExists = fs.existsSync(CONFIG_PATH);
    const currentHost = raw.minecraft?.host || '127.0.0.1';
    const currentPort = Number(raw.minecraft?.port) || 25565;
    const currentUsername = raw.minecraft?.username || 'EvoBot';
    const providers = raw.ai?.providers || {};
    const hasAnyKey = Object.values(providers).some((p: any) => (p?.apiKey || '').trim());
    const needsSetup = !configExists || !hasAnyKey || !String(currentHost).trim();

    if (!force && !needsSetup) return raw;
    if (!process.stdin.isTTY) {
        throw new Error('Missing required config and no interactive console is available');
    }

    console.log('First-time setup');
    console.log('Press Enter to keep the value shown in brackets.');
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const serverAnswer = await askQuestion(rl, `Minecraft server [${currentHost}:${currentPort}]: `);
        const server = parseServerAddress(serverAnswer || `${currentHost}:${currentPort}`, currentPort);
        const usernameAnswer = await askQuestion(rl, `Bot username [${currentUsername}]: `);

        raw.minecraft = { ...(raw.minecraft || {}), host: server.host, port: server.port, username: usernameAnswer.trim() || currentUsername };

        if (!raw.ai) raw.ai = {};
        if (!raw.ai.providers) raw.ai.providers = {};

        // DeepSeek
        const dsCfg = raw.ai.providers.deepseek || { baseURL: 'https://api.deepseek.com/v1', apiKey: '' };
        console.log('\n--- DeepSeek ---');
        const dsURL = await askQuestion(rl, `  Base URL [${dsCfg.baseURL}]: `);
        const dsKey = await askQuestion(rl, `  API key [${dsCfg.apiKey?.trim() ? (dsCfg.apiKey || '').slice(0, 12) + '...' : 'none'}]: `);
        raw.ai.providers.deepseek = {
            baseURL: dsURL.trim() || dsCfg.baseURL,
            apiKey: dsKey.trim() || dsCfg.apiKey || '',
        };

        // Kimi
        const kimiCfg = raw.ai.providers.kimi || { baseURL: 'https://api.moonshot.cn/v1', apiKey: '' };
        console.log('\n--- Kimi ---');
        const kimiURL = await askQuestion(rl, `  Base URL [${kimiCfg.baseURL}]: `);
        const kimiKey = await askQuestion(rl, `  API key [${kimiCfg.apiKey?.trim() ? (kimiCfg.apiKey || '').slice(0, 12) + '...' : 'none'}]: `);
        raw.ai.providers.kimi = {
            baseURL: kimiURL.trim() || kimiCfg.baseURL,
            apiKey: kimiKey.trim() || kimiCfg.apiKey || '',
        };

        // Thirdparty (OpenAI compatible)
        const tpCfg = raw.ai.providers.thirdparty || { baseURL: 'https://api.openai.com/v1', apiKey: '' };
        console.log('\n--- Thirdparty (OpenAI compatible) ---');
        const tpURL = await askQuestion(rl, `  Base URL [${tpCfg.baseURL}]: `);
        const tpKey = await askQuestion(rl, `  API key [${tpCfg.apiKey?.trim() ? (tpCfg.apiKey || '').slice(0, 12) + '...' : 'none'}]: `);
        raw.ai.providers.thirdparty = {
            baseURL: tpURL.trim() || tpCfg.baseURL,
            apiKey: tpKey.trim() || tpCfg.apiKey || '',
        };

        raw.ai.model = raw.ai.model || 'deepseek-v4-flash';
        raw.ai.provider = '';
        if (raw.ai.apiKey !== undefined) delete raw.ai.apiKey;
        if (raw.ai.apiKeyFile !== undefined) delete raw.ai.apiKeyFile;
        if (raw.ai.baseURL !== undefined) delete raw.ai.baseURL;

        saveRawConfig(raw);
        console.log('');
        console.log(`Saved config to ${CONFIG_PATH}`);
        return raw;
    } finally {
        rl.close();
    }
}

console.log('================================');
console.log('  EvoBot v7 — AI Driven');
console.log('================================');

function helpText(core: EvoBotV7): string {
    return [
        'EvoBot Console',
        '',
        'Core:',
        '/help                         Show this help',
        '/setup                        Edit API key / server in console',
        '/setkey <provider> <key>      Quickly set provider API key',
        '/status                       Show full runtime status',
        '/target                       Show target/task summary',
        '/tasks                        Show runtime task + queue',
        '/memory [query]                Show retrieved local memory/RAG context',
        '/web <query>                   Query optional web/MCP knowledge provider',
        '/clear                        Clear console output',
        '/quit                         Exit process',
        '',
        'Chat / Actions:',
        '/say <message>                Send chat message',
        '/move <x> <y> <z>             Queue move_to',
        '/follow [player] [dist]       Start continuous follow task',
        '/search <target> [kind]       Search nearby target (kind: entity|block)',
        '/make <item>                  Queue craft_chain',
        '/stop                         Stop current work',
        '',
        'Sensing:',
        '/scan [query]                 Scan nearby players/entities/blocks',
        '/players                      List nearby players',
        '/entities                     List nearby entities',
        '/blocks                       List nearby useful blocks',
        '',
        'Model:',
        `/model [name]                 Show/switch model | provider: ${core.getProvider()} | model: ${core.getModel()}`,
        '',
        'Aliases without / still work, but slash commands are preferred.',
    ].join('\n');
}

process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err.message);
    console.error(err.stack);
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
});

let core: any;
async function main(): Promise<void> {
    let rawConfig: any;
    try {
        rawConfig = await ensurePortableConfig(loadRawConfig());
        const config = loadConfig(rawConfig);
        core = config.backend === 'mc-api' ? new EvoBotMcApi(config) : new EvoBotV7(config);
    } catch (e) {
        console.error('[FATAL] Failed to create bot:', (e as Error).message);
        console.error((e as Error).stack);
        process.exit(1);
    }

    if (!process.stdin.isTTY) return;

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '/> ' });

    const writeLog = (method: (...args: any[]) => void, args: any[]) => {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        method(...args);
        rl.prompt(true);
    };

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origErr = console.error.bind(console);
    console.log = (...args: any[]) => writeLog(origLog, args);
    console.warn = (...args: any[]) => writeLog(origWarn, args);
    console.error = (...args: any[]) => writeLog(origErr, args);

    const parseCommand = (line: string): { cmd: string; args: string[] } => {
        const trimmed = line.trim();
        if (!trimmed) return { cmd: '', args: [] };
        const body = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
        const [cmd, ...args] = body.split(/\s+/);
        return { cmd: cmd.toLowerCase(), args };
    };

    rl.on('line', (line: string) => {
        const { cmd, args } = parseCommand(line);
        switch (cmd) {
            case '':
                break;
            case 'help':
            case '?':
                console.log(helpText(core));
                break;
            case 'setup':
                rl.pause();
                runInteractiveSetup(loadRawConfig(), true)
                    .then((nextRaw) => {
                        rawConfig = nextRaw;
                        console.log('Config updated. Restart the bot to apply the new server/API settings.');
                        rl.prompt();
                    })
                    .catch((err) => {
                        console.error('[SETUP] Failed:', err.message);
                        rl.prompt();
                    })
                    .finally(() => rl.resume());
                return;
            case 'setkey':
                if (!args[0] || !args[1]) {
                    console.log('Usage: /setkey <provider> <api-key>');
                    console.log('Providers: deepseek, kimi, thirdparty');
                } else {
                    const provider = args[0].toLowerCase();
                    const key = args.slice(1).join(' ');
                    saveProviderKey(provider, key, rawConfig);
                    console.log(`Key set for provider: ${provider}`);
                    core.setProviderKey(provider, key);
                }
                break;
            case 'say':
                core.chat(args.join(' '));
                break;
            case 'move':
                core.replaceWithTask('move_to', {
                    x: parseFloat(args[0]) || 0,
                    y: parseFloat(args[1]) || 0,
                    z: parseFloat(args[2]) || 0,
                    reachDistance: 2,
                });
                console.log(`Queued move_to -> (${args[0] ?? '?'}, ${args[1] ?? '?'}, ${args[2] ?? '?'})`);
                break;
            case 'follow':
                core.followPlayer(args[0], Number(args[1]) || 12, 2, 100);
                console.log(`Runtime follow task -> ${args[0] || '(nearest player)'} dist=${Number(args[1]) || 12}`);
                break;
            case 'search':
                if (!args[0]) {
                    console.log('Usage: /search <target> [entity|block]');
                    break;
                }
                core.searchTarget(args[0], args[1] === 'block' ? 'block' : 'entity', 24, 100, 12);
                console.log(`Runtime search task -> ${args[0]} (${args[1] === 'block' ? 'block' : 'entity'})`);
                break;
            case 'model':
                if (!args[0]) {
                    console.log(`Current model: ${core.getModel()} (provider: ${core.getProvider()})`);
                    console.log(`Available: ${core.listModels()}`);
                } else {
                    core.setModel(args[0]);
                }
                break;
            case 'make':
                if (!args[0]) {
                    console.log(`Craft chains: ${core.listCraftChains()}`);
                    console.log('Usage: /make <item>');
                } else {
                    core.queueTask('craft_chain', { item: args[0] });
                    console.log(`Queued craft_chain: ${args[0]}`);
                }
                break;
            case 'status':
                console.log(core.getStatusSummary());
                break;
            case 'target':
                console.log(core.getStatusSummary().split('\n').slice(1, 6).join('\n'));
                break;
            case 'tasks':
                console.log(core.getTasksSummary());
                break;
            case 'memory':
                console.log(core.getMemorySummary(args.join(' ')));
                break;
            case 'web':
                if (!args[0]) {
                    console.log('Usage: /web <query>');
                    console.log('Set EVOBOT_WEB_KNOWLEDGE_URL to enable an HTTP/MCP-style search endpoint.');
                    break;
                }
                rl.pause();
                core.getWebKnowledgeSummary(args.join(' '))
                    .then((summary: string) => console.log(summary))
                    .catch((err: Error) => console.error('[WEB] Failed:', err.message))
                    .finally(() => { rl.resume(); rl.prompt(); });
                return;
            case 'scan':
                console.log(core.getScanSummary(args.join(' '), 24));
                break;
            case 'players':
                console.log(core.getPlayersSummary(48));
                break;
            case 'entities':
                console.log(core.getEntitiesSummary(24, 12));
                break;
            case 'blocks':
                console.log(core.getBlocksSummary(24, 12));
                break;
            case 'clear':
                console.clear();
                break;
            case 'stop':
                core.stopAll();
                console.log('Stopped all work');
                break;
            case 'quit':
            case 'exit':
                core.bot?.quit();
                process.exit(0);
                break;
            default:
                console.log(`Unknown command: /${cmd}`);
                console.log('Use /help');
        }
        rl.prompt();
    });

    console.log(helpText(core));
    if (!core.hasAnyProviderKey()) {
        console.log('No API key configured yet. Use:');
        console.log('  /setkey deepseek <your-key>');
        console.log('  /setkey kimi <your-key>');
        console.log('  /setkey thirdparty <your-key>');
    }
    rl.prompt();
}

void main();

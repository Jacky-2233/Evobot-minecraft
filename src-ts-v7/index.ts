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

console.log('================================');
console.log('  EvoBot v7 — AI Driven');
console.log('================================');

function helpText(core: EvoBotV7): string {
    return [
        'EvoBot Console',
        '',
        'Core:',
        '/help                         Show this help',
        '/status                       Show full runtime status',
        '/target                       Show target/task summary',
        '/tasks                        Show runtime task + queue',
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
        `/model [name]                 Show/switch model (${core.listModels()})`,
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

let core: EvoBotV7;
try {
    core = new EvoBotV7(loadConfig());
} catch (e) {
    console.error('[FATAL] Failed to create bot:', (e as Error).message);
    console.error((e as Error).stack);
    process.exit(1);
}

if (process.stdin.isTTY) {
    const readline = require('readline');
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
                    console.log(`Current model: ${core.getModel()}`);
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
    rl.prompt();
}

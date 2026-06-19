/**
 * EvoBot v6 Entry Point
 *
 * Start with: npx tsx src-ts/index.ts
 */
import { EvoBotCore } from './core/bot.js';
import { createCollectSteps } from './skills/collect-steps.js';
import type { BotConfig } from './types/index.js';
import fs from 'fs';
import path from 'path';

// Load config from filesystem (same as old bot.js)
function loadConfig(): BotConfig {
    const configPath = path.join(process.cwd(), 'config.json');
    if (!fs.existsSync(configPath)) {
        throw new Error('config.json not found. Copy config.json.example.');
    }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    return {
        host: raw.minecraft?.host ?? '127.0.0.1',
        port: raw.minecraft?.port ?? 25565,
        username: raw.minecraft?.username ?? 'EvoBot',
        version: raw.minecraft?.version ?? '1.20.1',
        auth: (raw.minecraft?.auth as any) ?? 'offline',

        updateIntervalMs: raw.bot?.updateInterval ?? 300,
        autoReconnect: raw.bot?.autoReconnect ?? true,
        reconnectDelayMs: raw.bot?.reconnectDelay ?? 5000,

        hungerThreshold: raw.bot?.hungerThreshold ?? 16,
        lowHealthThreshold: raw.bot?.lowHealthThreshold ?? 8,
        criticalHealthThreshold: raw.bot?.criticalHealthThreshold ?? 4,

        stuckTimeoutMs: raw.bot?.stuckTimeoutMs ?? 20000,
        idleTimeoutMs: raw.bot?.idleTimeoutMs ?? 60000,

        ai: {
            apiKey: raw.ai?.apiKey ?? '',
            baseURL: raw.ai?.baseURL ?? 'https://api.deepseek.com/v1',
            model: raw.ai?.model ?? 'deepseek-v4-flash',
            maxTokens: raw.ai?.maxTokens ?? 200,
            timeoutMs: raw.ai?.replyTimeout ?? 15000,
        },
    };
}

// ─── Start ──────────────────────────────────────────────
console.log('================================');
console.log('  EvoBot v6 — TypeScript Edition');
console.log('================================\n');

const config = loadConfig();
const core = new EvoBotCore({ config });

// Console commands (stdin)
if (process.stdin.isTTY) {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.on('line', (line: string) => {
        const [cmd, ...args] = line.trim().split(/\s+/);
        switch (cmd) {
            case 'plan':
                if (!args[0]) { console.log('Usage: plan <goal>'); break; }
                core.plan(args.join(' ')).then((r: any) => {
                    console.log(`Plan result: ${r.success ? 'OK' : 'FAIL'} — ${r.detail}`);
                });
                break;
            case 'say':
                core.bot?.chat(args.join(' '));
                break;
            case 'move':
                core.addTask({
                    type: 'move_to',
                    params: {
                        x: parseFloat(args[0]) || 0,
                        y: parseFloat(args[1]) || 0,
                        z: parseFloat(args[2]) || 0,
                    },
                    priority: 7,
                    source: 'console',
                });
                break;
            case 'collect':
                core.addTask({
                    type: 'collect',
                    params: { target: args[0] || 'log', count: parseInt(args[1]) || 5 },
                    priority: 6,
                    source: 'console',
                });
                break;
            case 'collect2':
                // Step-based collect (atomic steps for 8s connection windows)
                if (!args[0]) { console.log('Usage: collect2 <block> [count]'); break; }
                {
                    const target = args[0];
                    const count = parseInt(args[1]) || 2;
                    const sequence = createCollectSteps(core.bot, target, count, 10);
                    console.log(`Starting step-based collect: ${target} x${count} (${sequence.steps.length} steps)`);
                    core.executeStepSequence(sequence).then((r) => {
                        console.log(`Step collect result: ${r.ok ? 'OK' : 'FAIL'} — ${r.detail}`);
                    });
                }
                break;
            case 'scan': {
                const s = (core as any).perception?.scan();
                if (!s) { console.log('Perception not ready'); break; }
                console.log(`Day=${s.timeOfDay}  HP=${s.health}  Food=${s.food}  OnGround=${s.onGround}`);
                console.log(`Hostile (${s.nearbyHostile.length}): ${s.nearbyHostile.slice(0, 5).map((e: any) => `${e.name} ${e.distance.toFixed(1)}m`).join(', ')}`);
                console.log(`Top blocks: ${s.nearbyBlocks.slice(0, 5).map((b: any) => `${b.name} x${b.count}`).join(', ')}`);
                break;
            }
            case 'mem':
                console.log(core.memory.getContextWindow(15));
                break;
            case 'search':
                if (!args[0]) { console.log('Usage: search <query>'); break; }
                console.table(
                    core.memory.search(args.join(' '), 10).map((e: any) => ({
                        time: new Date(e.timestamp).toISOString().slice(11, 19),
                        type: e.type,
                        summary: e.summary.slice(0, 60),
                    })),
                );
                break;
            case 'stop':
                core.executor.clear();
                core.bot?.pathfinder?.stop();
                core.bot?.clearControlStates();
                break;
            case 'status': {
                const cur = core.executor.getCurrentTask();
                const history = core.executor.getHistory(3);
                const safetyPhase = (core as any).safety?.recoveryPhase ?? 'none';
                console.log(`Queue: ${core.executor.getQueueDepth()} | Current: ${cur?.type ?? 'idle'} | Safety: ${safetyPhase}`);
                console.log(`Memory: ${core.memory.size} entries | Skills failing: ${core.memory.isSkillFalling ? 'check...' : 'OK'}`);
                if (history.length) {
                    console.log('Last 3 results:');
                    history.forEach((h: any) => {
                        const status = h.result.ok ? 'OK' : 'FAIL';
                        console.log(`  ${status} ${h.task.type} (${h.elapsedMs}ms, ${h.retries}r): ${h.result.detail}`);
                    });
                }
                break;
            }
            case 'spec': {
                const mins = parseInt(args[0]) || 10;
                console.log(core.generateSpecFromGaps(mins));
                break;
            }
            case 'gap': {
                let format: 'text' | 'json' | 'top' = 'text';
                let mins = 10;
                for (const arg of args) {
                    if (arg === 'raw') format = 'json';
                    else if (arg === 'top') format = 'top';
                    else { const n = parseInt(arg); if (n > 0) mins = n; }
                }
                console.log(core.analyzeGaps(mins, format));
                break;
            }
            case 'quit':
                core.shutdown();
                process.exit(0);
            default:
                console.log('Commands: say, move, collect, collect2, scan, mem, gap [mins|raw|top], spec [mins], search <q>, stop, status, quit');
        }
    });
}

process.on('SIGINT', () => {
    core.shutdown();
    process.exit(0);
});

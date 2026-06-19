/**
 * EvoBot v6 Entry Point
 *
 * Start with: npx tsx src-ts/index.ts
 */
import { EvoBotCore } from './core/bot.js';
import { createCollectSteps } from './skills/collect-steps.js';
import { fileLogger } from './utils/logger.js';
import type { BotConfig } from './types/index.js';
import fs from 'fs';
import path from 'path';

// Start file logging
fileLogger.start();

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

    /** Build a short status line showing current goal */
    function getGoalLine(): string {
        const cur = core.executor.getCurrentTask();
        const seq = core.stepExecutor.getCurrentSequence();
        const stepRunning = core.stepExecutor.isRunning;

        if (stepRunning && seq) {
            const step = seq.steps[seq.currentStepIndex];
            return `[step] ${seq.name} · step ${seq.currentStepIndex + 1}/${seq.steps.length} (${step?.name ?? ''})`;
        }
        if (cur) {
            const goal = (cur.params as any)?.target ?? (cur.params as any)?.goal ?? '';
            return `[${cur.type}] ${goal} ${cur.params?.count ? `x${cur.params.count}` : ''}`;
        }
        return 'idle';
    }

    /** Refresh prompt with current goal */
    function refreshPrompt(): void {
        rl.setPrompt(`[${getGoalLine()}] > `);
        rl.prompt(true);
    }

    rl.on('line', (line: string) => {
        const [cmd, ...args] = line.trim().split(/\s+/);
        switch (cmd) {
            case 'plan':
                if (!args[0]) { console.log('Usage: plan <goal>'); break; }
                core.plan(args.join(' ')).then((r: any) => {
                    console.log(`Plan result: ${r.success ? 'OK' : 'FAIL'} — ${r.detail}`);
                    refreshPrompt();
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
                if (!args[0]) { console.log('Usage: collect2 <block> [count]'); break; }
                {
                    const target = args[0];
                    const count = parseInt(args[1]) || 2;
                    const sequence = createCollectSteps(core.bot, target, count, 10);
                    console.log(`Starting step-based collect: ${target} x${count} (${sequence.steps.length} steps)`);
                    core.executeStepSequence(sequence).then((r) => {
                        console.log(`Step collect result: ${r.ok ? 'OK' : 'FAIL'} — ${r.detail}`);
                        refreshPrompt();
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
                core.stepExecutor.cancel();
                core.bot?.pathfinder?.stop();
                core.bot?.clearControlStates();
                break;
            case 'status': {
                const cur = core.executor.getCurrentTask();
                const seq = core.stepExecutor.getCurrentSequence();
                const stepRunning = core.stepExecutor.isRunning;
                const history = core.executor.getHistory(3);
                const safetyPhase = (core as any).safety?.recoveryPhase ?? 'none';
                const ph = (core as any).positionHealth;
                const phState = ph?.state?.[0] ?? '?';
                const behav = (core as any).behavior;
                const activeBeh = behav?.activeName ?? 'none';

                console.log('── Bot Status ───────────────────────');
                console.log(`Queue: ${core.executor.getQueueDepth()} | Safety: ${safetyPhase} | PH: ${phState}`);
                console.log(`Behavior: ${activeBeh} | Memory: ${core.memory.size} entries`);

                if (stepRunning && seq) {
                    const step = seq.steps[seq.currentStepIndex];
                    console.log(`Step Sequence: ${seq.name} [${seq.currentStepIndex + 1}/${seq.steps.length}]`);
                    console.log(`  Current Step: ${step?.name} (${step?.type})`);
                    console.log(`  State keys: ${Object.keys(seq.state).join(', ') || '(none)'}`);
                } else if (cur) {
                    const goal = (cur.params as any)?.target ?? (cur.params as any)?.goal ?? '';
                    console.log(`Current Task: ${cur.type} ${goal} ${cur.params?.count ? `x${cur.params.count}` : ''}`);
                    console.log(`  Priority: ${cur.priority} | Source: ${cur.source}`);
                } else {
                    console.log('Current: idle');
                }

                if (history.length) {
                    console.log('Last 3 results:');
                    history.forEach((h: any) => {
                        const status = h.result.ok ? 'OK' : 'FAIL';
                        console.log(`  ${status} ${h.task.type} (${h.elapsedMs}ms, ${h.retries}r): ${h.result.detail}`);
                    });
                }

                // Show step history
                const stepHistory = core.stepExecutor.getHistory(5);
                if (stepHistory.length > 0) {
                    console.log('Last step results:');
                    stepHistory.forEach((h: any) => {
                        const status = h.result.ok ? 'OK' : 'FAIL';
                        console.log(`  ${status} ${h.stepName} (${h.elapsedMs}ms): ${h.result.detail}`);
                    });
                }

                console.log('─────────────────────────────────────');
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
            case 'model':
                if (!args[0]) {
                    console.log(`Current model: ${core.getModel()}`);
                    console.log('Usage: model <name>  — e.g. model deepseek-v4-flash');
                } else {
                    core.setModel(args[0]);
                }
                break;
            case 'start':
                core.connect();
                break;
            case 'disconnect':
                core.disconnect();
                break;
            case 'server':
                if (args.length < 2) {
                    console.log(`Current: ${(core as any).config?.host ?? '?'}:${(core as any).config?.port ?? '?'}`);
                    console.log('Usage: server <host> <port>');
                } else {
                    core.setServer(args[0], parseInt(args[1]) || 25565);
                }
                break;
            case 'think':
                console.log(core.getLastThink());
                break;
            case 'craft':
                if (!args[0]) {
                    console.log('Usage: craft <item> [count]');
                    console.log('Known recipes: planks, stick, crafting_table, furnace, wooden_pickaxe, stone_pickaxe, iron_pickaxe, wooden_axe, stone_axe, wooden_sword, stone_sword');
                } else {
                    core.addTask({
                        type: 'craft',
                        params: { item: args[0], count: parseInt(args[1]) || 1 },
                        priority: 6,
                        source: 'console',
                    });
                }
                break;
            case 'inv':
                console.log(core.inventoryManager.summary());
                console.log(`Free slots: ${core.inventoryManager.freeSlots}`);
                break;
            case 'session':
                console.log(core.sessionStats.summary());
                break;
            default:
                console.log('Commands: say, move, collect, collect2, scan, mem, gap [mins|raw|top], spec [mins], search <q>, stop, status, model <name>, start, disconnect, server <host> <port>, think, craft <item> [count], inv, session, quit');
        }
        refreshPrompt();
    });

    // Refresh prompt periodically (every 2s) to show current goal changes
    setInterval(refreshPrompt, 2000);
    refreshPrompt();
}

process.on('SIGINT', () => {
    core.shutdown();
    fileLogger.stop();
    process.exit(0);
});

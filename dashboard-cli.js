#!/usr/bin/env node
/**
 * EvoBot CLI Dashboard — Terminal chat interface
 * Usage: node dashboard-cli.js
 */

const http = require('http');
const readline = require('readline');

const API = 'http://127.0.0.1:3000';

// Colors (ANSI)
const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m',
};

function api(endpoint, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const options = { method, headers: { 'Content-Type': 'application/json' } };
        const req = http.request(`${API}${endpoint}`, options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function box(text, color = C.cyan) {
    const lines = text.split('\n');
    const maxLen = Math.max(...lines.map(l => stripAnsi(l).length));
    const top = color + '╔' + '═'.repeat(maxLen + 2) + '╗' + C.reset;
    const bottom = color + '╚' + '═'.repeat(maxLen + 2) + '╝' + C.reset;
    console.log(top);
    for (const line of lines) {
        const pad = ' '.repeat(maxLen - stripAnsi(line).length);
        console.log(color + '║' + C.reset + ' ' + line + pad + ' ' + color + '║' + C.reset);
    }
    console.log(bottom);
}

function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
}

async function showStatus() {
    try {
        const s = await api('/api/status');
        if (!s.online) {
            console.log(C.red + '  Bot is OFFLINE' + C.reset);
            return false;
        }
        const pos = s.position ? `${s.position.x} ${s.position.y} ${s.position.z}` : 'unknown';
        const lines = [
            `${C.green}●${C.reset} Online  ${C.dim}|${C.reset}  ${C.green}HP:${C.reset} ${s.health}  ${C.yellow}Food:${C.reset} ${s.food}`,
            `${C.cyan}📍${C.reset} ${pos}`,
            s.task?.current
                ? `${C.magenta}📋${C.reset} Task: ${s.task.current.type}  |  Queued: ${s.task.queued}`
                : `${C.dim}📋 No active tasks${C.reset}`,
            `🎒 Inventory: ${s.inventory?.slotsUsed || 0}/36 slots used`,
        ];
        box(lines.join('\n'), C.cyan);
        return true;
    } catch (e) {
        console.log(C.red + `  ❌ Bot not running at ${API}` + C.reset);
        return false;
    }
}

function helpText() {
    console.log('');
    console.log(C.bold + '  Commands:' + C.reset);
    console.log('  ' + C.yellow + '/status' + C.reset + '    Show bot status');
    console.log('  ' + C.yellow + '/follow' + C.reset + '    Follow Jacky_MC_');
    console.log('  ' + C.yellow + '/collect <x>' + C.reset + ' Collect resource (log, stone, coal)');
    console.log('  ' + C.yellow + '/attack' + C.reset + '    Attack nearby mobs');
    console.log('  ' + C.yellow + '/stop' + C.reset + '      Stop current task');
    console.log('  ' + C.yellow + '/farm' + C.reset + '      Harvest crops');
    console.log('  ' + C.yellow + '/build' + C.reset + '     Build shelter');
    console.log('  ' + C.yellow + '/deposit' + C.reset + '   Deposit items to chest');
    console.log('  ' + C.yellow + '/help' + C.reset + '      Show this help');
    console.log('  ' + C.yellow + '/quit' + C.reset + '      Exit');
    console.log('');
    console.log(C.dim + '  Or just type a message to chat with the bot...' + C.reset);
    console.log('');
}

async function main() {
    console.clear();
    box('EvoBot v5.0 Dashboard', C.green);
    console.log('');

    const ok = await showStatus();
    if (!ok) {
        console.log(C.dim + '\n  Start the bot first: npm start' + C.reset);
        console.log('');
        process.exit(1);
    }

    helpText();

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: C.green + 'EvoBot' + C.reset + ' > ',
    });

    rl.prompt();

    rl.on('line', async (input) => {
        const line = input.trim();
        if (!line) {
            rl.prompt();
            return;
        }

        // Commands
        if (line.startsWith('/')) {
            const [cmd, ...args] = line.substring(1).split(/\s+/);
            const arg = args.join(' ');

            switch (cmd) {
                case 'quit':
                case 'exit':
                    console.log(C.dim + '  Goodbye!' + C.reset);
                    process.exit(0);
                case 'status':
                    await showStatus();
                    break;
                case 'follow':
                    console.log(C.yellow + '  → Following...' + C.reset);
                    await api('/api/chat', 'POST', { command: 'follow Jacky_MC_' });
                    break;
                case 'collect':
                    console.log(C.yellow + `  → Collecting ${arg || 'log'}...` + C.reset);
                    await api('/api/chat', 'POST', { command: `collect ${arg || 'log'}` });
                    break;
                case 'attack':
                    console.log(C.red + '  → Attacking...' + C.reset);
                    await api('/api/chat', 'POST', { command: 'attack' });
                    break;
                case 'stop':
                    console.log(C.yellow + '  → Stopping...' + C.reset);
                    await api('/api/chat', 'POST', { command: 'stop' });
                    break;
                case 'farm':
                    console.log(C.yellow + '  → Farming...' + C.reset);
                    await api('/api/chat', 'POST', { command: 'farm' });
                    break;
                case 'build':
                    console.log(C.yellow + '  → Building...' + C.reset);
                    await api('/api/chat', 'POST', { command: 'build' });
                    break;
                case 'deposit':
                    console.log(C.yellow + '  → Depositing...' + C.reset);
                    await api('/api/chat', 'POST', { command: 'deposit cobblestone dirt' });
                    break;
                case 'help':
                    helpText();
                    break;
                default:
                    console.log(C.red + `  Unknown command: /${cmd}` + C.reset);
                    console.log(C.dim + '  Type /help for commands' + C.reset);
            }
        } else {
            // Chat with bot
            process.stdout.write(C.cyan + '  You: ' + C.reset + line + '\n');
            process.stdout.write(C.dim + '  ...' + C.reset);
            try {
                const res = await api('/api/talk', 'POST', { message: line });
                if (res.ok && res.reply) {
                    process.stdout.write('\r' + ' '.repeat(20) + '\r');
                    console.log(C.green + '  EvoBot: ' + C.reset + res.reply);
                } else if (res.ok && !res.reply) {
                    process.stdout.write('\r' + ' '.repeat(20) + '\r');
                    console.log(C.yellow + '  EvoBot: ' + C.reset + '[action]');
                } else {
                    process.stdout.write('\r' + ' '.repeat(20) + '\r');
                    console.log(C.red + '  Error: ' + C.reset + 'no response');
                }
            } catch (e) {
                process.stdout.write('\r' + ' '.repeat(20) + '\r');
                console.log(C.red + '  Error: ' + C.reset + e.message);
            }
        }

        console.log('');
        rl.prompt();
    });

    rl.on('close', () => {
        console.log(C.dim + '\n  Goodbye!' + C.reset);
        process.exit(0);
    });

    // Periodic status update (every 30s)
    setInterval(async () => {
        if (rl.line !== undefined) return; // user is typing
        try {
            const s = await api('/api/status');
            if (s.online) {
                const pos = s.position ? `${s.position.x} ${s.position.y} ${s.position.z}` : '?';
                process.stdout.write('\r' + C.dim + `  [${s.health}HP ${s.food}Food @${pos}]` + C.reset + '\n' + C.green + 'EvoBot' + C.reset + ' > ');
            }
        } catch (e) { /* ignore */ }
    }, 30000);
}

main().catch(e => {
    console.log(C.red + 'Fatal error: ' + C.reset + e.message);
    process.exit(1);
});

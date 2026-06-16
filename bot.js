const Agent = require('./src/core/Agent');
const readline = require('readline');

console.log('\n======================================');
console.log('  EvoBot v5.0 - Self-Evolving AI Agent');
console.log('======================================\n');

const agent = new Agent();
agent.start();

// Console commands (only if stdin is interactive)
if (process.stdin.isTTY) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.on('line', (input) => {
        agent.handleConsoleCommand(input);
    });

    rl.on('close', () => {
        agent.bot?.quit();
        process.exit(0);
    });
}

// Graceful shutdown on SIGINT
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    agent.bot?.quit();
    process.exit(0);
});

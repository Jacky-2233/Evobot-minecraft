/**
 * EvoBot v6 Test Entry
 *
 * Tests core v6 components: StepExecutor, CheckpointManager,
 * StepSequence lifecycle, and NaN guard.
 *
 * Run: npx tsx test-v6.ts
 */
import { CheckpointManager } from './src-ts/layers/checkpoint.js';

// ─── Mock Bot ────────────────────────────────────────────
const mockBot: any = {
    entity: {
        position: { x: 0, y: 64, z: 0, floored: () => ({ x: 0, y: 64, z: 0 }) },
    },
    inventory: {
        items: () => [],
        emptySlotCount: () => 36,
    },
};

// ─── Test 1: Checkpoint step-level save/load/clear ──────
function testCheckpoint(): boolean {
    console.log('── Test: Checkpoint step-level save/load/clear ──');
    const ckpt = new CheckpointManager('logs/test-checkpoint.json', 'logs/test-step-checkpoint.json');

    const stepCkpt = {
        sequenceId: 'test-seq-1',
        sequenceName: 'collect_stone',
        currentStepIndex: 3,
        state: { collected_0: true, collected_1: true, totalCollected: 2 },
        completedSteps: ['scan_0', 'select_0', 'move_0', 'dig_0', 'scan_1', 'select_1', 'move_1', 'dig_1'],
        progress: { total: 10, completed: 8 },
        savedAt: Date.now(),
    };

    ckpt.saveStepCheckpoint(stepCkpt);
    const loaded = ckpt.loadStepCheckpoint();
    if (!loaded) { console.log('  FAIL: loadStepCheckpoint returned null'); return false; }
    if (loaded.sequenceId !== 'test-seq-1') { console.log(`  FAIL: sequenceId mismatch, got ${loaded.sequenceId}`); return false; }
    if (loaded.currentStepIndex !== 3) { console.log(`  FAIL: currentStepIndex mismatch, got ${loaded.currentStepIndex}`); return false; }
    console.log(`  PASS: saved/loaded step checkpoint at index ${loaded.currentStepIndex}`);

    ckpt.clearStepCheckpoint();
    const afterClear = ckpt.loadStepCheckpoint();
    if (afterClear !== null) { console.log('  FAIL: step checkpoint not cleared'); return false; }
    console.log('  PASS: step checkpoint cleared');

    // Cleanup test files
    try { require('fs').unlinkSync('logs/test-checkpoint.json'); } catch {}
    try { require('fs').unlinkSync('logs/test-step-checkpoint.json'); } catch {}
    return true;
}

// ─── Test 2: StepSequence creation ───────────────────────
function testStepSequenceCreation(): boolean {
    console.log('── Test: StepSequence creation ──');
    const { createCollectSteps } = require('./src-ts/skills/collect-steps.js');

    const seq = createCollectSteps(mockBot, 'stone', 2, 10);
    if (!seq) { console.log('  FAIL: createCollectSteps returned null'); return false; }
    if (seq.steps.length !== 9) { console.log(`  FAIL: expected 9 steps, got ${seq.steps.length}`); return false; }
    if (seq.name !== 'collect_stone') { console.log(`  FAIL: expected name collect_stone, got ${seq.name}`); return false; }
    if (seq.currentStepIndex !== 0) { console.log(`  FAIL: expected currentStepIndex 0, got ${seq.currentStepIndex}`); return false; }
    console.log(`  PASS: created sequence with ${seq.steps.length} steps`);
    console.log(`  Steps: ${seq.steps.map((s: any) => s.id).join(', ')}`);
    return true;
}

// ─── Test 3: StepExecutor execute and cancel ─────────────
async function testStepExecutor(): Promise<boolean> {
    console.log('── Test: StepExecutor execute and cancel ──');
    const { StepExecutor } = require('./src-ts/executor/step-executor.js');
    const { CheckpointManager } = require('./src-ts/layers/checkpoint.js');

    const ckpt = new CheckpointManager('logs/test-checkpoint.json', 'logs/test-step-checkpoint.json');
    const executor = new StepExecutor(mockBot, ckpt);

    // Create a simple 3-step test sequence
    const { createStep, createStepSequence } = require('./src-ts/types/index.js');
    const steps = [
        createStep('step1', 'First step', 'validate', async (ctx: any) => {
            ctx.state.visited = ['step1'];
            return { ok: true, state: { step1Done: true }, detail: 'Step 1 done' };
        }, 1000),
        createStep('step2', 'Second step', 'validate', async (ctx: any) => {
            if (!ctx.state.step1Done) return { ok: false, detail: 'Step 1 not done', failureType: 'internal_error' };
            ctx.state.visited.push('step2');
            return { ok: true, state: { step2Done: true }, detail: 'Step 2 done' };
        }, 1000, false, ['step1']),
        createStep('step3', 'Third step', 'validate', async (ctx: any) => {
            ctx.state.visited.push('step3');
            return { ok: true, detail: 'Step 3 done' };
        }, 1000, false, ['step2']),
    ];

    const seq = createStepSequence('test-exec', 'test_seq', steps);

    // Execute
    const result = await executor.execute(seq);
    if (!result.ok) { console.log(`  FAIL: sequence failed: ${result.detail}`); return false; }
    if (seq.currentStepIndex !== 3) { console.log(`  FAIL: expected final index 3, got ${seq.currentStepIndex}`); return false; }
    console.log(`  PASS: sequence completed (${result.detail})`);

    // Check state was passed between steps
    const visited = seq.state.visited as string[];
    if (!visited || visited.length !== 3) { console.log(`  FAIL: expected 3 visited steps, got ${visited?.length}`); return false; }
    console.log(`  PASS: state chaining works (visited: ${visited.join(' → ')})`);

    // Cleanup
    executor.cancel();
    ckpt.clearStepCheckpoint();
    try { require('fs').unlinkSync('logs/test-checkpoint.json'); } catch {}
    try { require('fs').unlinkSync('logs/test-step-checkpoint.json'); } catch {}
    return true;
}

// ─── Test 4: StepExecutor timeout ────────────────────────
async function testStepTimeout(): Promise<boolean> {
    console.log('── Test: StepExecutor step timeout ──');
    const { StepExecutor } = require('./src-ts/executor/step-executor.js');
    const { CheckpointManager } = require('./src-ts/layers/checkpoint.js');
    const { createStep, createStepSequence } = require('./src-ts/types/index.js');

    const ckpt = new CheckpointManager('logs/test-checkpoint.json', 'logs/test-step-checkpoint.json');
    const executor = new StepExecutor(mockBot, ckpt);

    // Step that takes too long
    const step = createStep('slow', 'Slow step', 'wait', async (ctx: any) => {
        await new Promise(r => setTimeout(r, 5000));
        return { ok: true, detail: 'Done too late' };
    }, 500); // 500ms timeout

    const seq = createStepSequence('test-timeout', 'test_timeout', [step]);
    const result = await executor.execute(seq);
    if (result.ok) { console.log('  FAIL: expected timeout but got ok'); return false; }
    if (result.failureType !== 'timeout') { console.log(`  FAIL: expected timeout, got ${result.failureType}`); return false; }
    console.log(`  PASS: step timed out correctly (${result.detail})`);

    ckpt.clearStepCheckpoint();
    try { require('fs').unlinkSync('logs/test-checkpoint.json'); } catch {}
    try { require('fs').unlinkSync('logs/test-step-checkpoint.json'); } catch {}
    return true;
}

// ─── Test 5: NaN Guard ───────────────────────────────────
function testNanGuard(): boolean {
    console.log('── Test: NaN Guard ──');
    const { isFiniteVec3, NaNTracer } = require('./src-ts/utils/nan-guard.js');

    // Valid vec3
    if (!isFiniteVec3({ x: 1, y: 2, z: 3 })) { console.log('  FAIL: valid vec3 rejected'); return false; }
    if (isFiniteVec3({ x: NaN, y: 2, z: 3 })) { console.log('  FAIL: NaN x not caught'); return false; }
    if (isFiniteVec3({ x: Infinity, y: 2, z: 3 })) { console.log('  FAIL: Infinity x not caught'); return false; }
    if (isFiniteVec3({ x: 1, y: 2, z: undefined } as any)) { console.log('  FAIL: undefined z not caught'); return false; }
    console.log('  PASS: isFiniteVec3 guards work');

    // NaN tracer
    const tracer = new NaNTracer(5);
    tracer.trace('test', { pos: { x: NaN, y: 2, z: 3 } });
    tracer.trace('test2', { pos: { x: 1, y: NaN, z: 3 } });
    const dump = tracer.dump('test dump');
    if (dump.length < 2) { console.log(`  FAIL: expected 2+ traces, got ${dump.length}`); return false; }
    console.log(`  PASS: NaNTracer captures events (${dump.length} entries)`);
    return true;
}

// ─── Run All Tests ───────────────────────────────────────
async function main() {
    console.log('================================');
    console.log('  EvoBot v6 — Test Suite');
    console.log('================================\n');

    const tests: Array<{ name: string; fn: () => boolean | Promise<boolean> }> = [
        { name: 'Checkpoint step-level', fn: testCheckpoint },
        { name: 'StepSequence creation', fn: testStepSequenceCreation },
        { name: 'StepExecutor execution', fn: testStepExecutor },
        { name: 'StepExecutor timeout', fn: testStepTimeout },
        { name: 'NaN Guard', fn: testNanGuard },
    ];

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
        process.stdout.write(`\n${test.name}... `);
        try {
            const ok = await test.fn();
            if (ok) {
                passed++;
                console.log(`✓ ${test.name} PASSED`);
            } else {
                failed++;
                console.log(`✗ ${test.name} FAILED`);
            }
        } catch (err: unknown) {
            failed++;
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`✗ ${test.name} CRASHED: ${msg}`);
        }
    }

    console.log('\n═════════════════════════════════════');
    console.log(`Result: ${passed}/${passed + failed} passed, ${failed} failed`);
    console.log(failed === 0 ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
    console.log('═════════════════════════════════════\n');
}

main().catch(console.error);

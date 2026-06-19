/**
 * Gap Detector Calibration Test
 *
 * Populates memory with synthetic entries matching each test scenario,
 * then runs the detector and compares actual vs expected categories.
 *
 * Run: npx tsx test-gap-detector.ts
 */
import { Memory } from './src-ts/layers/memory.js';
import { GapDetector } from './src-ts/layers/gap-detector.js';
import type { GapCategory } from './src-ts/types/index.js';

interface TestCase {
    id: string;
    scenario: string;
    expected: GapCategory;
    populate: (mem: Memory, baseTs: number) => void;
    /** true if this test is expected to fail (known limitation) */
    expectedFail?: boolean;
}

const tests: TestCase[] = [
    // ─── Scenario 1: Sample too small → noise ─────────────
    {
        id: 'S1',
        scenario: '样本不足 (1~2次失败)',
        expected: 'environment_noise',
        populate: (mem, ts) => {
            mem.recordTask(makeTaskResult('move_to', 'timeout', false, 'path timeout', 8000, 1, ts));
            mem.recordTask(makeTaskResult('move_to', 'timeout', false, 'path timeout again', 12000, 1, ts + 10000));
        },
    },

    // ─── Scenario 2: Precondition fast rejection ──────────
    {
        id: 'S2',
        scenario: '前置条件秒拒 (collect 无目标, 4次)',
        expected: 'no_gap_precondition',
        populate: (mem, ts) => {
            for (let i = 0; i < 4; i++) {
                mem.recordTask(makeTaskResult(
                    'collect', 'not_possible', false,
                    'Block not found',
                    500, 0, ts + i * 2000,
                    { target: 'nonexistent_block' },
                ));
            }
        },
    },

    // ─── Scenario 3: Param issue (timeout, had successes) ─
    {
        id: 'S3',
        scenario: '参数过紧 (short timeout, 4 fail + 1 success)',
        expected: 'no_gap_param_issue',
        populate: (mem, ts) => {
            // 1 success first
            mem.recordTask(makeTaskResult('move_to', 'none', true, 'reached', 2000, 0, ts - 10000));
            // 4 timeout failures
            for (let i = 0; i < 4; i++) {
                mem.recordTask(makeTaskResult(
                    'move_to', 'timeout', false,
                    'Movement timeout',
                    3000, 1, ts + i * 3000,
                    { x: -500, y: 70, z: -500 },
                ));
            }
        },
    },

    // ─── Scenario 4: Recovery (target_lost, had successes) ─
    {
        id: 'S4',
        scenario: '目标丢失可恢复 (pickup target_lost, 3 fail + 1 success)',
        expected: 'no_gap_recovery_issue',
        populate: (mem, ts) => {
            mem.recordTask(makeTaskResult('pickup', 'none', true, 'Picked up 2 items', 3000, 0, ts - 5000));
            for (let i = 0; i < 3; i++) {
                mem.recordTask(makeTaskResult(
                    'pickup', 'target_lost', false,
                    'No items nearby',
                    2000, 1, ts + i * 3000,
                ));
            }
        },
    },

    // ─── Scenario 5A: Planner fast reject → precondition ──
    {
        id: 'S5A',
        scenario: 'planner秒拒 (elapsed<2s, not_possible) → precondition',
        expected: 'no_gap_precondition',
        populate: (mem, ts) => {
            for (let i = 0; i < 4; i++) {
                mem.recordTask(makeTaskResult(
                    'collect', 'not_possible', false,
                    'Cannot collect bedrock',
                    600, 0, ts + i * 2000,
                    { target: 'bedrock' },
                    'planner',
                ));
            }
        },
    },

    // ─── Scenario 5B: Planner non-fast → planner_issue ────
    {
        id: 'S5B',
        scenario: 'planner非秒拒 (blocked, elapsed>2s) → planner_issue',
        expected: 'no_gap_planner_issue',
        populate: (mem, ts) => {
            for (let i = 0; i < 4; i++) {
                mem.recordTask(makeTaskResult(
                    'move_to', 'blocked', false,
                    'Path blocked by wall',
                    5000, 2, ts + i * 5000,
                    { x: 100, y: 70, z: 100 },
                    'planner',
                ));
            }
        },
    },

    // ─── Scenario 6: Real skill gap (cross-location) ──────
    {
        id: 'S6',
        scenario: '真技能缺口 (水域move_to stuck, 6次, 无成功)',
        expected: 'skill_gap',
        populate: (mem, ts) => {
            for (let i = 0; i < 6; i++) {
                mem.recordTask(makeTaskResult(
                    'move_to', 'path_stuck', false,
                    'Stuck in water at river crossing',
                    8000, 3, ts + i * 4000,
                    { x: 50 + i * 5, y: 63, z: 50 + i * 5 },
                ));
            }
        },
    },

    // ─── Scenario 7: Same-location stuck → likely mis-report ─
    {
        id: 'S7',
        scenario: '固定地点陷阱 (同位置move_to stuck, 6次) — 预期误报',
        expected: 'skill_gap',
        expectedFail: true, // known limitation
        populate: (mem, ts) => {
            for (let i = 0; i < 6; i++) {
                mem.recordTask(makeTaskResult(
                    'move_to', 'path_stuck', false,
                    'Stuck at swamp edge',
                    7000, 2, ts + i * 5000,
                    { x: 100, y: 63, z: 100 }, // same location every time
                ));
            }
        },
    },

    // ─── Scenario 8: Mixed failure types → noise ──────────
    {
        id: 'S8',
        scenario: '混合失败类型 (同actionKey, 多种failType各1-2次)',
        expected: 'environment_noise',
        populate: (mem, ts) => {
            mem.recordTask(makeTaskResult('move_to', 'timeout', false, 'timeout 1', 10000, 1, ts));
            mem.recordTask(makeTaskResult('move_to', 'timeout', false, 'timeout 2', 12000, 1, ts + 2000));
            mem.recordTask(makeTaskResult('move_to', 'path_stuck', false, 'stuck 1', 6000, 2, ts + 4000));
            mem.recordTask(makeTaskResult('move_to', 'blocked', false, 'blocked 1', 4000, 1, ts + 6000));
            mem.recordTask(makeTaskResult('move_to', 'blocked', false, 'blocked 2', 5000, 1, ts + 8000));
            mem.recordTask(makeTaskResult('move_to', 'target_lost', false, 'lost', 3000, 0, ts + 10000));
        },
    },
];

// ─── Helpers ──────────────────────────────────────────────────

import { SpecGenerator } from './src-ts/layers/spec-generator.js';

function makeTaskResult(
    taskType: string,
    failureType: string,
    ok: boolean,
    detail: string,
    elapsedMs: number,
    retries: number,
    ts: number,
    params?: Record<string, unknown>,
    source?: string,
) {
    return {
        task: {
            id: `test-${Math.random().toString(36).slice(2, 8)}`,
            type: taskType,
            params: params ?? {},
            priority: 5,
            createdAt: ts,
            source: source ?? 'console',
        },
        result: {
            ok,
            detail,
            failureType,
        },
        elapsedMs,
        retries,
    } as any;
}

// ─── Run Tests ────────────────────────────────────────────────

console.log('=== Gap Detector Calibration Test ===\n');
console.log('Current thresholds:');
console.log('  minSamples=3, skillGapMinCount=5, paramIssueMinFailRate=0.6');
console.log('  preconditionMaxElapsedMs=2000, maxRetriesForSkillGap=3');
console.log('');

let passed = 0;
let failed = 0;
let expectedFailPassed = 0;

for (const test of tests) {
    const memory = new Memory({ maxEntries: 200, defaultExpiryMs: 0, minImportance: 0 });
    const detector = new GapDetector(memory);

    // Populate memory with synthetic entries
    const now = Date.now();
    test.populate(memory, now - 120000); // all entries within last 2 min

    // Run analysis
    const report = detector.analyze(180000); // 3 min window

    // Find the finding for this scenario's actionKey
    const finding = report.findings[0];

    const actualCategory = finding?.category ?? 'environment_noise';
    const match = actualCategory === test.expected;

    const status = test.expectedFail
        ? (match ? 'EXPECTED_FAIL (confirmed)' : 'UNEXPECTED (was: ' + actualCategory + ')')
        : (match ? 'PASS' : 'FAIL (got: ' + actualCategory + ', expected: ' + test.expected + ')');

    if (test.expectedFail && match) expectedFailPassed++;
    else if (match) passed++;
    else failed++;

    console.log(`[${test.id}] ${test.scenario}`);
    console.log(`  Expected: ${test.expected}${test.expectedFail ? ' [KNOWN LIMITATION]' : ''}`);
    console.log(`  Actual:   ${actualCategory}`);
    console.log(`  ${status}`);

    if (finding) {
        console.log(`  Summary:  ${finding.summary}`);
        console.log(`  Action:   ${finding.recommendedAction}`);
        console.log(`  Evidence: ${finding.evidence.count}x, ${(finding.evidence.failRate * 100).toFixed(0)}% fail, ${finding.evidence.avgElapsedMs.toFixed(0)}ms avg`);
        console.log(`  Reason:   ${finding.debugReason?.join(' → ') ?? '(none)'}`);
    } else {
        console.log('  (no findings — classified as noise)');
    }

    if (!match && !test.expectedFail) {
        console.log('\n  Debug — all findings:');
        for (const f of report.findings) {
            console.log(`    [${f.category}] ${f.actionKey} ${f.failureType} (${f.evidence.count}x, ${(f.evidence.failRate * 100).toFixed(0)}%) — ${f.summary}`);
        }
    }

    console.log('');
}

console.log('=== Results ===');
console.log(`PASS: ${passed}/${tests.length - 1} (excluding expected failures)`);
console.log(`FAIL: ${failed}`);
console.log(`Expected failures confirmed: ${expectedFailPassed}`);
console.log('');

if (failed === 0) {
    console.log('RESULT: PASS — Detector rules are reliable. Proceed to P1 observability changes.');
} else {
    console.log(`RESULT: FAIL — ${failed} tests did not match. Fix rules before adding observability.`);
}

console.log('\n=== Spec Generator Test ===\n');

const specTests = [
    { id: 'S6', expectedName: 'swim_to_land' },
    { id: 'S7', expectedName: 'escape_stuck' },
];

// Re-run S6 and S7 to get their findings, feed to SpecGenerator
for (const st of specTests) {
    const test = tests.find((t) => t.id === st.id)!;
    const memory = new Memory({ maxEntries: 200, defaultExpiryMs: 0, minImportance: 0 });
    const detector = new GapDetector(memory);
    const now = Date.now();
    test.populate(memory, now - 120000);
    const report = detector.analyze(180000);
    const finding = report.findings.find((f) => f.category === 'skill_gap');

    if (!finding) {
        console.log(`[${st.id}] No skill_gap finding — cannot test spec`);
        continue;
    }

    const generator = new SpecGenerator();
    const spec = generator.generate(finding);

    console.log(`[${st.id}] expected: ${st.expectedName} → actual: ${spec?.name ?? 'null'}`);
    if (spec) {
        console.log(`  Description: ${spec.description}`);
        console.log(`  Steps: ${spec.steps.length}`);
        spec.steps.forEach((s) => console.log(`    ${s.order}. ${s.action} — ${s.description}`));
        console.log(`  Success: ${spec.successCondition}`);
        console.log(`  Fails: ${spec.failReasons.join(', ')}`);
    }
    console.log('');
}

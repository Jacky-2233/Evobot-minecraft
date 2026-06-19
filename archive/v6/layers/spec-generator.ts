/**
 * Skill Spec Generator
 *
 * Converts a skill_gap GapFinding into a structured SkillSpec
 * that a developer agent can implement. Rule-based + template-fill.
 * No LLM — uses pattern matching against known gap signatures.
 */
import type { GapFinding, SkillSpec, SkillSpecStep } from '../types/index.js';

/** Gap signature: maps (actionKey, failureType, keyword pattern) → SkillSpec template */
interface GapSignature {
    actionKey: string;
    failureType: string;
    keyword?: string;
    spec: Omit<SkillSpec, 'sourceFinding' | 'relatedActionKey'>;
}

// ─── Gap Signature Registry ──────────────────────────────

const signatures: GapSignature[] = [
    {
        actionKey: 'move_to',
        failureType: 'path_stuck',
        keyword: 'water',
        spec: {
            name: 'swim_to_land',
            description: 'Escape from water by swimming toward the nearest solid land block above the waterline.',
            trigger: 'Bot is in water for more than 3 seconds and pathfinder is stuck.',
            goal: 'Reach dry land safely.',
            preconditions: [
                'Bot is in water',
                'At least one solid land block detected above waterline within 16 blocks',
                'Bot has health > 4',
            ],
            steps: [
                { order: 1, action: 'stop_pathfinder', description: 'Cancel any current pathfinding', onFailure: 'skip' },
                { order: 2, action: 'scan_blocks', params: { aboveWaterline: true, radius: 16 }, description: 'Find nearest solid block above water', onFailure: 'abort' },
                { order: 3, action: 'look_at', params: { target: 'found_block' }, description: 'Face the target land block', onFailure: 'skip' },
                { order: 4, action: 'set_control', params: { key: 'jump', state: true }, description: 'Hold jump to stay afloat', onFailure: 'skip' },
                { order: 5, action: 'set_control', params: { key: 'forward', state: true }, description: 'Swim toward land', onFailure: 'skip' },
                { order: 6, action: 'wait_until', params: { condition: 'onGround', timeoutMs: 15000 }, description: 'Wait until on solid ground', onFailure: 'retry' },
                { order: 7, action: 'clear_controls', description: 'Release all control states', onFailure: 'skip' },
            ],
            successCondition: 'bot is on solid ground and not in water',
            failReasons: ['no_land_found', 'health_critical', 'timeout', 'blocked_in_water'],
        },
    },
    {
        actionKey: 'move_to',
        failureType: 'path_stuck',
        spec: {
            name: 'escape_stuck',
            description: 'Try alternative movement strategies when pathfinder is stuck: jump, move sideways, back up, retry.',
            trigger: 'Bot pathfinder reports path_stuck for more than 2 consecutive ticks.',
            goal: 'Get unstuck and resume travel.',
            preconditions: [
                'Pathfinder reports stuck',
                'Bot is not in water',
                'Bot health > 0',
            ],
            steps: [
                { order: 1, action: 'stop_pathfinder', description: 'Cancel current path', onFailure: 'skip' },
                { order: 2, action: 'clear_controls', description: 'Release held keys', onFailure: 'skip' },
                { order: 3, action: 'set_control', params: { key: 'jump', state: true }, description: 'Jump to get unstuck', onFailure: 'skip' },
                { order: 4, action: 'sleep', params: { ms: 500 }, description: 'Wait for physics to settle', onFailure: 'skip' },
                { order: 5, action: 'clear_controls', description: 'Release jump', onFailure: 'skip' },
                { order: 6, action: 'move_rel', params: { dx: -2, dz: 0, timeoutMs: 2000 }, description: 'Back up a few blocks', onFailure: 'skip' },
                { order: 7, action: 'move_rel', params: { dx: 2, dz: 2, timeoutMs: 2000 }, description: 'Sidestep and retry', onFailure: 'abort' },
            ],
            successCondition: 'Bot has moved at least 2 blocks from stuck position',
            failReasons: ['still_stuck', 'timeout', 'damage_taken'],
        },
    },
    {
        actionKey: 'pickup',
        failureType: 'target_lost',
        spec: {
            name: 'reacquire_item',
            description: 'When a dropped item disappears before pickup, scan for other nearby items instead of failing immediately.',
            trigger: 'Pickup skill reports target_lost.',
            goal: 'Pick up any nearby dropped items.',
            preconditions: [
                'Previous pickup target was lost',
                'Inventory has at least 2 empty slots',
            ],
            steps: [
                { order: 1, action: 'rescan_items', params: { radius: 10 }, description: 'Re-scan for any dropped items in larger radius', onFailure: 'abort' },
                { order: 2, action: 'move_to', params: { target: 'nearest_item', reachDistance: 1 }, description: 'Navigate to the nearest found item', onFailure: 'skip' },
                { order: 3, action: 'sleep', params: { ms: 300 }, description: 'Wait for pickup by proximity', onFailure: 'skip' },
            ],
            successCondition: 'At least one item picked up or no items remain in range',
            failReasons: ['no_items_found', 'inventory_full', 'path_blocked'],
        },
    },
    {
        actionKey: 'collect',
        failureType: 'target_lost',
        spec: {
            name: 'reacquire_target',
            description: 'When a block to collect disappears or becomes unreachable, find the nearest alternative of the same type.',
            trigger: 'Collect skill reports target_lost or no_resource.',
            goal: 'Find and collect an alternative block of the same type.',
            preconditions: [
                'Original collect target was lost',
                'Same block type exists within scan radius',
            ],
            steps: [
                { order: 1, action: 'rescan_blocks', params: { blockType: 'original_target', radius: 15 }, description: 'Re-scan for same block type nearby', onFailure: 'abort' },
                { order: 2, action: 'move_to', params: { target: 'nearest_match', reachDistance: 2 }, description: 'Navigate to new target', onFailure: 'abort' },
                { order: 3, action: 'collect', params: { target: 'original_target', count: 1 }, description: 'Collect the new target block', onFailure: 'skip' },
            ],
            successCondition: 'At least one block of the target type collected',
            failReasons: ['no_alternative_found', 'block_unreachable', 'tool_missing'],
        },
    },
    {
        actionKey: 'retreat',
        failureType: 'path_stuck',
        spec: {
            name: 'retreat_safe',
            description: 'When retreat path is blocked, try alternative escape directions or vertical escape (pillar up).',
            trigger: 'Retreat skill reports path_stuck.',
            goal: 'Escape to a safer position.',
            preconditions: [
                'Retreat path is blocked',
                'Bot health > 0',
            ],
            steps: [
                { order: 1, action: 'stop_pathfinder', description: 'Cancel retreat movement', onFailure: 'skip' },
                { order: 2, action: 'clear_controls', description: 'Release all keys', onFailure: 'skip' },
                { order: 3, action: 'set_control', params: { key: 'jump', state: true }, description: 'Attempt vertical escape', onFailure: 'skip' },
                { order: 4, action: 'move_rel', params: { dx: 3, dz: 3, timeoutMs: 3000 }, description: 'Try a different horizontal direction', onFailure: 'skip' },
                { order: 5, action: 'clear_controls', description: 'Release controls', onFailure: 'skip' },
                { order: 6, action: 'retreat', params: { distance: 12 }, description: 'Retry retreat to safe distance', onFailure: 'abort' },
            ],
            successCondition: 'Bot moved at least 8 blocks from danger zone',
            failReasons: ['trapped', 'timeout', 'health_critical'],
        },
    },
];

// ─── Spec Generator ──────────────────────────────────────

export interface SpecGeneratorConfig {
    /** If no matching signature is found, generate a generic fallback spec */
    generateFallback: boolean;
}

const DEFAULT_CONFIG: SpecGeneratorConfig = {
    generateFallback: true,
};

export class SpecGenerator {
    private config: SpecGeneratorConfig;

    constructor(config?: Partial<SpecGeneratorConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /** Convert a skill_gap finding into a SkillSpec */
    generate(finding: GapFinding): SkillSpec | null {
        if (finding.category !== 'skill_gap') return null;

        // Try exact match: actionKey + failureType + keyword
        for (const sig of signatures) {
            if (sig.actionKey !== finding.actionKey) continue;
            if (sig.failureType !== finding.failureType) continue;

            if (sig.keyword) {
                // Check if finding summary or targetKey contains the keyword
                const haystack = (finding.summary + ' ' + (finding.targetKey ?? '')).toLowerCase();
                if (!haystack.includes(sig.keyword)) continue;
            }

            return this.fillTemplate(sig.spec, finding);
        }

        // Try fallback: actionKey + failureType (no keyword)
        for (const sig of signatures) {
            if (sig.actionKey !== finding.actionKey) continue;
            if (sig.failureType !== finding.failureType) continue;
            if (sig.keyword) continue; // keyword sigs already checked above

            return this.fillTemplate(sig.spec, finding);
        }

        // Generic fallback
        if (this.config.generateFallback) {
            return this.generateFallbackSpec(finding);
        }

        return null;
    }

    /** Generate specs for ALL skill_gap findings in a report */
    generateAll(findings: GapFinding[]): SkillSpec[] {
        return findings
            .filter((f) => f.category === 'skill_gap')
            .map((f) => this.generate(f))
            .filter((s): s is SkillSpec => s !== null);
    }

    // ─── Internal ────────────────────────────────────────

    private fillTemplate(
        template: Omit<SkillSpec, 'sourceFinding' | 'relatedActionKey'>,
        finding: GapFinding,
    ): SkillSpec {
        return {
            ...template,
            relatedActionKey: finding.actionKey,
            sourceFinding: {
                summary: finding.summary,
                evidenceCount: finding.evidence.count,
                evidenceFailRate: finding.evidence.failRate,
            },
        };
    }

    private generateFallbackSpec(finding: GapFinding): SkillSpec {
        const capPhrase = `${finding.actionKey}_${finding.failureType}_recovery`;
        return {
            name: capPhrase,
            description: `Auto-generated fallback spec for gap: ${finding.summary}`,
            trigger: `${finding.actionKey} skill fails with ${finding.failureType}.`,
            goal: `Recover or succeed where ${finding.actionKey} currently fails.`,
            preconditions: [
                `Previous ${finding.actionKey} failed with ${finding.failureType}`,
                'Bot is alive and can act',
            ],
            steps: [
                {
                    order: 1,
                    action: 'stop_pathfinder',
                    description: 'Cancel any running action',
                    onFailure: 'skip',
                },
                {
                    order: 2,
                    action: 'clear_controls',
                    description: 'Reset control states',
                    onFailure: 'skip',
                },
                {
                    order: 3,
                    action: 'retry_task',
                    params: { taskType: finding.actionKey, maxRetries: 1 },
                    description: `Retry the ${finding.actionKey} task once`,
                    onFailure: 'abort',
                },
            ],
            successCondition: `${finding.actionKey} task completed successfully`,
            failReasons: ['timeout', 'target_lost', 'no_resource', 'blocked'],
            relatedActionKey: finding.actionKey,
            sourceFinding: {
                summary: finding.summary,
                evidenceCount: finding.evidence.count,
                evidenceFailRate: finding.evidence.failRate,
            },
        };
    }
}

// ─── Export helper for standalone use ────────────────────

/** Quick convert a single skill_gap finding to a spec */
export function gapToSpec(finding: GapFinding): SkillSpec | null {
    const gen = new SpecGenerator();
    return gen.generate(finding);
}

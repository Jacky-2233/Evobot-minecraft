/**
 * Vertical Dig Stance Planner
 *
 * Before digging a block, choose a stable, reachable stance.
 * Solves the problem of bot standing on leaves or directly
 * above/below a target and failing to dig.
 *
 * Core idea: ask "where is the best place to stand?" instead of
 * "what's the closest point to the target?"
 */
import type { Bot } from 'mineflayer';
import { isFiniteVec3 } from '../../utils/nan-guard.js';

// ─── Types ──────────────────────────────────────────────

export type DigRelativeType =
    | 'same_level'
    | 'below'
    | 'above'
    | 'diagonal_below'
    | 'diagonal_above'
    | 'under_feet'
    | 'over_head'
    | 'unreachable_geometry';

export interface DigStanceCandidate {
    position: { x: number; y: number; z: number };
    score: number;
    reasons: string[];
    distanceToBot: number;
    distanceToTarget: number;
    stableFooting: boolean;
    riskyFooting: boolean;
    lineOfSightLikely: boolean;
    requiresJumpLook: boolean;
    relativeType: DigRelativeType;
}

export interface DigStanceResult {
    ok: boolean;
    relativeType: DigRelativeType;
    target: { x: number; y: number; z: number; name?: string };
    stance?: DigStanceCandidate;
    alternatives?: DigStanceCandidate[];
    reason?: string;
    debug: {
        botPosition: { x: number; y: number; z: number };
        examinedCandidates: number;
        rejected: string[];
    };
}

export type DigStanceFailReason =
    | 'no_dig_stance'
    | 'unsafe_footing'
    | 'target_under_feet'
    | 'target_out_of_reach'
    | 'head_clearance_blocked'
    | 'line_of_sight_blocked'
    | 'position_health_disallows_dig'
    | 'target_lost_before_dig';

export interface DigStancePlannerConfig {
    maxHorizontalRadius: number;
    allowLeafFooting: boolean;
    allowWaterFooting: boolean;
    allowEdgeFooting: boolean;
    preferSolidGround: boolean;
    maxBotToStanceDistance: number;
    maxTargetReachDistance: number;
    preferSameYBand: boolean;
    penalizeStandingOnLeaves: number;
    penalizeUnsafeDrop: number;
}

// ─── Private helpers ────────────────────────────────────

type Vec3 = { x: number; y: number; z: number };

function vec3(x: number, y: number, z: number): Vec3 {
    return { x, y, z };
}

function floorVec3(v: Vec3): Vec3 {
    return { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) };
}

function distance(a: Vec3, b: Vec3): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function distanceCenter(a: Vec3, b: Vec3): number {
    return distance(
        { x: a.x + 0.5, y: a.y + 0.5, z: a.z + 0.5 },
        { x: b.x + 0.5, y: b.y + 0.5, z: b.z + 0.5 },
    );
}

function isSolid(bot: Bot, pos: Vec3): boolean {
    const block = bot.blockAt(pos as any);
    if (!block || block.name === 'air') return false;
    if (block.name === 'lava' || block.name === 'water' || block.name === 'flowing_water' || block.name === 'flowing_lava') return false;
    const bbox = block.boundingBox;
    if (bbox === 'empty') return false;
    return true;
}

function isStandable(bot: Bot, pos: Vec3): boolean {
    const block = bot.blockAt(pos as any);
    if (!block || block.name === 'air' || block.name === 'lava') return false;
    const bbox = block.boundingBox;
    return bbox !== 'empty';
}

function isLeaves(block: any): boolean {
    return block?.name?.includes('leaves') ?? false;
}

function isWater(block: any): boolean {
    return block?.name === 'water' || block?.name === 'flowing_water';
}

function isLog(block: any): boolean {
    return block?.name?.includes('log') || block?.name?.includes('wood');
}

function isOre(block: any): boolean {
    return block?.name?.includes('ore');
}

// ─── Classification ─────────────────────────────────────

const DEFAULT_CONFIG: DigStancePlannerConfig = {
    maxHorizontalRadius: 3,
    allowLeafFooting: false,
    allowWaterFooting: false,
    allowEdgeFooting: false,
    preferSolidGround: true,
    maxBotToStanceDistance: 8,
    maxTargetReachDistance: 4.5,
    preferSameYBand: true,
    penalizeStandingOnLeaves: 80,
    penalizeUnsafeDrop: 80,
};

/** Classify where the target is relative to the bot */
export function classifyDigRelativeType(botPos: Vec3, targetPos: Vec3): DigRelativeType {
    // Use block positions (integer coords) for classification
    const bx = Math.floor(botPos.x);
    const by = Math.floor(botPos.y);
    const bz = Math.floor(botPos.z);

    const tx = targetPos.x;
    const ty = targetPos.y;
    const tz = targetPos.z;

    const dx = tx - bx;
    const dy = ty - by;
    const dz = tz - bz;
    const adx = Math.abs(dx);
    const adz = Math.abs(dz);

    // under_feet: same horizontal, exactly one block below
    if (dx === 0 && dz === 0 && dy <= 0 && dy >= -1) return 'under_feet';

    // over_head: same horizontal, above
    if (dx === 0 && dz === 0 && dy >= 1) return 'over_head';

    // below: directly or diagonally below within 1 block
    if (dy < 0 && adx <= 1 && adz <= 1) {
        return adx === 0 && adz === 0 ? 'below' : 'diagonal_below';
    }

    // above: directly or diagonally above within 1 block
    if (dy > 0 && adx <= 1 && adz <= 1) {
        return adx === 0 && adz === 0 ? 'above' : 'diagonal_above';
    }

    // same_level
    if (dy === 0) return 'same_level';

    // Fallback
    if (adx <= 2 && adz <= 2 && Math.abs(dy) <= 3) {
        return dy < 0 ? 'diagonal_below' : 'diagonal_above';
    }

    return 'unreachable_geometry';
}

// ─── Candidate enumeration ──────────────────────────────

export function enumerateDigStanceCandidates(
    bot: Bot,
    targetBlock: any,
    config: DigStancePlannerConfig,
): DigStanceCandidate[] {
    const botPos = bot.entity.position;
    const tp = targetBlock.position;
    const targetVec = { x: tp.x, y: tp.y, z: tp.z };
    const candidates: DigStanceCandidate[] = [];
    const r = config.maxHorizontalRadius;

    // Enumerate stance positions around the target
    for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
            for (const dy of [-1, 0, 1]) {
                const stanceX = tp.x + dx;
                const stanceY = tp.y + dy;
                const stanceZ = tp.z + dz;
                const stancePos = { x: stanceX, y: stanceY, z: stanceZ };

                // Skip if too far from bot
                const distToBot = distance(botPos, stancePos);
                if (distToBot > config.maxBotToStanceDistance) continue;

                // Skip if too far from target
                const distToTarget = distanceCenter(stancePos, targetVec);
                if (distToTarget > config.maxTargetReachDistance) continue;

                // Check footing (block under feet)
                const footingBlock = bot.blockAt(
                    { x: stanceX, y: stanceY - 1, z: stanceZ } as any,
                );

                let stableFooting = false;
                let riskyFooting = false;
                const reasons: string[] = [];

                if (isWater(footingBlock)) {
                    if (!config.allowWaterFooting) continue;
                    riskyFooting = true;
                    reasons.push('standing_in_water');
                }
                if (isLeaves(footingBlock)) {
                    if (!config.allowLeafFooting) continue;
                    riskyFooting = true;
                    reasons.push('standing_on_leaves');
                }
                if (footingBlock?.name === 'air') {
                    // Check if it's edge footing (one block gap with solid below)
                    const belowFooting = bot.blockAt(
                        { x: stanceX, y: stanceY - 2, z: stanceZ } as any,
                    );
                    if (belowFooting?.name !== 'air' && config.allowEdgeFooting) {
                        riskyFooting = true;
                        reasons.push('edge_footing');
                    } else {
                        continue; // no footing at all
                    }
                }
                if (!isStandable(bot, { x: stanceX, y: stanceY - 1, z: stanceZ }) && !config.allowEdgeFooting) {
                    continue;
                }
                if (config.preferSolidGround && isStandable(bot, { x: stanceX, y: stanceY - 1, z: stanceZ })) {
                    stableFooting = true;
                }

                // Check head clearance
                const headBlock = bot.blockAt(
                    { x: stanceX, y: stanceY + 1, z: stanceZ } as any,
                );
                if (headBlock?.name !== 'air' && headBlock?.name !== 'water' && headBlock?.name !== 'flowing_water') {
                    continue; // head blocked
                }

                // Check stance block itself is air (can stand there)
                const stanceBlock = bot.blockAt(stancePos as any);
                if (stanceBlock?.name !== 'air' && stanceBlock?.name !== 'water' && stanceBlock?.name !== 'flowing_water') {
                    // Can't stand in a solid block unless it's the target we're going to dig
                    if (stanceBlock?.position?.x !== tp.x || stanceBlock?.position?.y !== tp.y || stanceBlock?.position?.z !== tp.z) {
                        continue;
                    }
                }

                // Line of sight heuristic
                let lineOfSightLikely = false;
                if (stableFooting && dy >= 0 && adx <= 1 && adz <= 1) {
                    lineOfSightLikely = true;
                }
                if (adx <= 1 && adz <= 1 && dy >= -1 && dy <= 1) {
                    lineOfSightLikely = true;
                }

                const relType = classifyDigRelativeType(stancePos, targetVec);
                let requiresJumpLook = false;
                if (relType === 'below' || relType === 'under_feet') {
                    requiresJumpLook = true;
                }

                // Calculate score
                let score = 100;
                if (stableFooting) {
                    score += 80;
                    reasons.push('stable_foothold');
                }
                if (lineOfSightLikely) {
                    score += 40;
                    reasons.push('clear_line_of_sight');
                }
                if (relType === 'same_level' || relType === 'below') {
                    score += 30;
                    reasons.push('optimal_relative_pos');
                }
                if (dy === 0 && config.preferSameYBand) {
                    score += 10;
                }

                score -= Math.floor(20 * distToBot);
                score -= Math.floor(10 * distToTarget);

                if (riskyFooting) {
                    score -= config.penalizeUnsafeDrop;
                    reasons.push('risky_foothold');
                }
                if (isLeaves(footingBlock)) {
                    score -= config.penalizeStandingOnLeaves;
                }

                // Special: penalize standing on leaves to dig logs
                if (isLeaves(footingBlock) && isLog(targetBlock)) {
                    score -= 100;
                    reasons.push('wood_dig_on_leaves_bad');
                }

                // Special: penalize standing on the target itself
                if (stanceX === tp.x && stanceY === tp.y && stanceZ === tp.z) {
                    continue; // Can't stand inside target
                }

                candidates.push({
                    position: stancePos,
                    score,
                    reasons,
                    distanceToBot: distToBot,
                    distanceToTarget: distToTarget,
                    stableFooting: stableFooting || (!riskyFooting && config.allowEdgeFooting),
                    riskyFooting,
                    lineOfSightLikely,
                    requiresJumpLook,
                    relativeType: relType,
                });
            }
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
}

// ─── Candidate evaluation ───────────────────────────────

export function evaluateDigStanceCandidate(
    bot: Bot,
    targetBlock: any,
    stancePos: Vec3,
    relativeType: DigRelativeType,
    config: DigStancePlannerConfig,
): DigStanceCandidate | null {
    const botPos = bot.entity.position;

    const distToBot = distance(botPos, stancePos);
    if (distToBot > config.maxBotToStanceDistance) return null;

    if (!isFiniteVec3(stancePos)) return null;

    const tp = targetBlock.position;
    const distToTarget = distanceCenter(stancePos, { x: tp.x, y: tp.y, z: tp.z });
    if (distToTarget > config.maxTargetReachDistance) return null;

    const footing = bot.blockAt({ x: stancePos.x, y: stancePos.y - 1, z: stancePos.z } as any);
    if (!config.allowEdgeFooting && footing?.name === 'air') return null;
    if (footing?.name === 'lava') return null;
    if (isWater(footing) && !config.allowWaterFooting) return null;
    if (isLeaves(footing) && !config.allowLeafFooting) return null;

    let score = 100;
    const reasons: string[] = [];
    let stableFooting = false;
    let riskyFooting = false;

    if (isStandable(bot, { x: stancePos.x, y: stancePos.y - 1, z: stancePos.z })) {
        stableFooting = true;
        score += 80;
        reasons.push('stable_foothold');
    }
    if (isLeaves(footing)) {
        riskyFooting = true;
        score -= config.penalizeStandingOnLeaves;
        reasons.push('standing_on_leaves');
    }
    if (isLog(targetBlock) && isLeaves(footing)) {
        score -= 100;
        reasons.push('wood_dig_on_leaves_bad');
    }

    score -= Math.floor(20 * distToBot);
    score -= Math.floor(10 * distToTarget);

    return {
        position: stancePos,
        score,
        reasons,
        distanceToBot: distToBot,
        distanceToTarget: distToTarget,
        stableFooting,
        riskyFooting,
        lineOfSightLikely: stableFooting,
        requiresJumpLook: relativeType === 'below' || relativeType === 'under_feet',
        relativeType,
    };
}

// ─── Main entry point ───────────────────────────────────

export function chooseDigStance(
    bot: Bot,
    targetBlock: any,
    config?: Partial<DigStancePlannerConfig>,
): DigStanceResult {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const botPos = bot.entity.position;
    const tp = targetBlock.position;
    const targetVec = { x: tp.x, y: tp.y, z: tp.z };

    const relativeType = classifyDigRelativeType(botPos, targetVec);

    const debug: DigStanceResult['debug'] = {
        botPosition: { x: botPos.x, y: botPos.y, z: botPos.z },
        examinedCandidates: 0,
        rejected: [],
    };

    const candidates = enumerateDigStanceCandidates(bot, targetBlock, cfg);
    debug.examinedCandidates = candidates.length;

    // Filter: remove candidates that are clearly bad
    const valid = candidates.filter((c) => {
        if (c.riskyFooting && !cfg.allowLeafFooting && !cfg.allowEdgeFooting) {
            debug.rejected.push(`risky:${c.position.x},${c.position.y},${c.position.z}`);
            return false;
        }
        if (c.distanceToTarget > cfg.maxTargetReachDistance) {
            debug.rejected.push(`too_far:${c.position.x},${c.position.y},${c.position.z}`);
            return false;
        }
        return true;
    });

    if (valid.length === 0) {
        return {
            ok: false,
            relativeType,
            target: { x: tp.x, y: tp.y, z: tp.z, name: targetBlock.name },
            reason: 'no_dig_stance',
            debug,
            alternatives: candidates.slice(0, 3),
        };
    }

    const best = valid[0];
    return {
        ok: true,
        relativeType,
        target: { x: tp.x, y: tp.y, z: tp.z, name: targetBlock.name },
        stance: best,
        alternatives: valid.slice(1, 4),
        debug,
    };
}

// ─── Post-stance validation ─────────────────────────────

export function validateCurrentStanceForDig(
    bot: Bot,
    targetBlock: any,
    config?: Partial<DigStancePlannerConfig>,
): { ok: boolean; reason?: string } {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const pos = bot.entity.position;

    if (!isFiniteVec3(pos)) {
        return { ok: false, reason: 'position_health_disallows_dig' };
    }

    // Check target still exists
    const current = bot.blockAt(targetBlock.position);
    if (!current || current.name !== targetBlock.name) {
        return { ok: false, reason: 'target_lost_before_dig' };
    }

    // Check footing
    const footing = bot.blockAt({ x: Math.floor(pos.x), y: Math.floor(pos.y) - 1, z: Math.floor(pos.z) } as any);
    if (!isStandable(bot, { x: Math.floor(pos.x), y: Math.floor(pos.y) - 1, z: Math.floor(pos.z) })) {
        if (!cfg.allowEdgeFooting) {
            return { ok: false, reason: 'unsafe_footing' };
        }
    }
    if (isLeaves(footing) && !cfg.allowLeafFooting) {
        return { ok: false, reason: 'unsafe_footing' };
    }

    // Check reach
    const dist = distance(bot.entity.position, targetBlock.position);
    if (dist > cfg.maxTargetReachDistance) {
        return { ok: false, reason: 'target_out_of_reach' };
    }

    return { ok: true };
}

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
    reason?: DigStanceFailReason;
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

function isFiniteNum(n: unknown): boolean {
    return typeof n === 'number' && Number.isFinite(n);
}

function vec3(x: number, y: number, z: number): Vec3 {
    return { x, y, z };
}

function floorVec3(v: Vec3): Vec3 {
    if (!isFiniteVec3(v)) return { x: 0, y: 0, z: 0 };
    return { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) };
}

function distance(a: Vec3, b: Vec3): number {
    if (!isFiniteVec3(a) || !isFiniteVec3(b)) return Infinity;
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function distanceCenter(a: Vec3, b: Vec3): number {
    if (!isFiniteVec3(a) || !isFiniteVec3(b)) return Infinity;
    return distance(
        { x: a.x + 0.5, y: a.y + 0.5, z: a.z + 0.5 },
        { x: b.x + 0.5, y: b.y + 0.5, z: b.z + 0.5 },
    );
}

function isAir(block: any): boolean {
    return !block || block.name === 'air';
}

function isLiquid(block: any): boolean {
    if (!block) return false;
    return block.name === 'water' || block.name === 'flowing_water'
        || block.name === 'lava' || block.name === 'flowing_lava';
}

function isSolid(bot: Bot, pos: Vec3): boolean {
    if (!isFiniteVec3(pos)) return false;
    const block = bot.blockAt(pos as any);
    if (!block || block.name === 'air') return false;
    if (isLiquid(block)) return false;
    const bbox = block.boundingBox;
    if (bbox === 'empty') return false;
    return true;
}

function isStandable(bot: Bot, pos: Vec3): boolean {
    if (!isFiniteVec3(pos)) return false;
    const block = bot.blockAt(pos as any);
    if (!block || block.name === 'air' || isLiquid(block)) return false;
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
    if (!block) return false;
    return block.name?.includes('log') || block.name?.includes('wood');
}

function isOre(block: any): boolean {
    return block?.name?.includes('ore');
}

// ─── Configuration ──────────────────────────────────────

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

// ─── Classification ─────────────────────────────────────

/** Classify where the target is relative to the bot */
export function classifyDigRelativeType(botPos: Vec3, targetPos: Vec3): DigRelativeType {
    if (!isFiniteVec3(botPos) || !isFiniteVec3(targetPos)) return 'unreachable_geometry';

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

    // under_feet: same horizontal, 0 or 1 below
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

    // Extended fallback for near-vertical (within 2 blocks)
    if (adx <= 2 && adz <= 2 && Math.abs(dy) <= 3) {
        return dy < 0 ? 'diagonal_below' : 'diagonal_above';
    }

    return 'unreachable_geometry';
}

// ─── Candidate enumeration ──────────────────────────────

/**
 * Enumerate all possible stance positions around a target block.
 * Each candidate represents where the bot's feet would be.
 */
export function enumerateDigStanceCandidates(
    bot: Bot,
    targetBlock: any,
    config: DigStancePlannerConfig,
): DigStanceCandidate[] {
    const botPos = bot.entity?.position;
    if (!isFiniteVec3(botPos)) return [];

    const tp = targetBlock.position;
    if (!isFiniteVec3(tp)) return [];

    const targetVec = { x: tp.x, y: tp.y, z: tp.z };
    const candidates: DigStanceCandidate[] = [];
    const r = config.maxHorizontalRadius;

    for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
            for (const dy of [-1, 0, 1]) {
                const stanceX = tp.x + dx;
                const stanceY = tp.y + dy;
                const stanceZ = tp.z + dz;
                const stancePos = { x: stanceX, y: stanceY, z: stanceZ };

                const distToBot = distance(botPos, stancePos);
                if (distToBot > config.maxBotToStanceDistance) continue;

                const distToTarget = distanceCenter(stancePos, targetVec);
                if (distToTarget > config.maxTargetReachDistance) continue;

                // ─── Check footing ───────────────────────────
                const footingPos = { x: stanceX, y: stanceY - 1, z: stanceZ };
                const footingBlock = bot.blockAt(footingPos as any);

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
                if (!footingBlock || footingBlock.name === 'air') {
                    const belowTwo = bot.blockAt({ x: stanceX, y: stanceY - 2, z: stanceZ } as any);
                    if (belowTwo && belowTwo.name !== 'air' && config.allowEdgeFooting) {
                        riskyFooting = true;
                        reasons.push('edge_footing');
                    } else {
                        continue;
                    }
                } else if (!isStandable(bot, footingPos) && !config.allowEdgeFooting) {
                    continue;
                }
                if (config.preferSolidGround && isStandable(bot, footingPos)) {
                    stableFooting = true;
                }

                // ─── Head clearance ──────────────────────────
                const headPos = { x: stanceX, y: stanceY + 1, z: stanceZ };
                const headBlock = bot.blockAt(headPos as any);
                if (headBlock && headBlock.name !== 'air' && !isWater(headBlock)) {
                    continue;
                }

                // ─── Stance block itself must be open ────────
                const stanceBlock = bot.blockAt(stancePos as any);
                if (stanceBlock && stanceBlock.name !== 'air' && !isWater(stanceBlock)) {
                    if (stanceBlock.position.x !== tp.x
                        || stanceBlock.position.y !== tp.y
                        || stanceBlock.position.z !== tp.z) {
                        continue;
                    }
                }

                // ─── Line of sight heuristic ─────────────────
                const dxc = dx;
                const dzc = dz;
                const adxc = Math.abs(dxc);
                const adzc = Math.abs(dzc);
                let lineOfSightLikely = false;
                if (stableFooting && dy >= 0 && adxc <= 1 && adzc <= 1) {
                    lineOfSightLikely = true;
                }
                if (adxc <= 1 && adzc <= 1 && dy >= -1 && dy <= 1) {
                    lineOfSightLikely = true;
                }
                // Additional: any stance with stable solid footing and close to target
                if (stableFooting && distToTarget <= 3) {
                    lineOfSightLikely = true;
                }

                const relType = classifyDigRelativeType(stancePos, targetVec);
                let requiresJumpLook = false;
                if (relType === 'below' || relType === 'under_feet' || relType === 'diagonal_below') {
                    requiresJumpLook = true;
                }

                // ─── Score ───────────────────────────────────
                let score = 100;
                if (stableFooting) { score += 80; reasons.push('stable_foothold'); }
                if (lineOfSightLikely) { score += 40; reasons.push('clear_line_of_sight'); }
                if (relType === 'same_level' || relType === 'below') { score += 30; reasons.push('optimal_relative_pos'); }
                if (dy === 0 && config.preferSameYBand) { score += 10; reasons.push('same_y_band'); }

                score -= Math.floor(20 * distToBot);
                score -= Math.floor(10 * distToTarget);

                if (riskyFooting) { score -= config.penalizeUnsafeDrop; reasons.push('risky_foothold'); }
                if (isLeaves(footingBlock)) { score -= config.penalizeStandingOnLeaves; reasons.push('standing_on_leaves'); }

                // ─── Special: wood on leaves ────────────────
                if (isLeaves(footingBlock) && isLog(targetBlock)) {
                    score -= 100;
                    reasons.push('wood_dig_on_leaves_bad');
                }

                // ─── Cannot stand inside the target ─────────
                if (stanceX === tp.x && stanceY === tp.y && stanceZ === tp.z) {
                    continue;
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

// ─── Single candidate evaluation ────────────────────────

export function evaluateDigStanceCandidate(
    bot: Bot,
    targetBlock: any,
    stancePos: Vec3,
    relativeType: DigRelativeType,
    config: DigStancePlannerConfig,
): DigStanceCandidate | null {
    const botPos = bot.entity?.position;
    if (!isFiniteVec3(botPos) || !isFiniteVec3(stancePos)) return null;

    const distToBot = distance(botPos, stancePos);
    if (distToBot > config.maxBotToStanceDistance) return null;

    const tp = targetBlock.position;
    if (!isFiniteVec3(tp)) return null;

    const distToTarget = distanceCenter(stancePos, { x: tp.x, y: tp.y, z: tp.z });
    if (distToTarget > config.maxTargetReachDistance) return null;

    const footingPos = { x: stancePos.x, y: stancePos.y - 1, z: stancePos.z };
    const footing = bot.blockAt(footingPos as any);
    if (!config.allowEdgeFooting && (!footing || footing.name === 'air')) return null;
    if (footing?.name === 'lava') return null;
    if (isWater(footing) && !config.allowWaterFooting) return null;
    if (isLeaves(footing) && !config.allowLeafFooting) return null;

    let score = 100;
    const reasons: string[] = [];
    let stableFooting = false;
    let riskyFooting = false;

    if (isStandable(bot, footingPos)) {
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

    // Head clearance
    const headPos = { x: stancePos.x, y: stancePos.y + 1, z: stancePos.z };
    const headBlock = bot.blockAt(headPos as any);
    const headClear = !headBlock || headBlock.name === 'air' || isWater(headBlock);
    if (!headClear) return null;

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
        requiresJumpLook: relativeType === 'below' || relativeType === 'under_feet' || relativeType === 'diagonal_below',
        relativeType,
    };
}

// ─── Tree / Leaves special handling ─────────────────────

/** Check if a log block is surrounded by leaves (tree crown context) */
function hasNearbyLeaves(bot: Bot, logPos: Vec3, radius = 2): boolean {
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;
                const p = { x: logPos.x + dx, y: logPos.y + dy, z: logPos.z + dz };
                const b = bot.blockAt(p as any);
                if (isLeaves(b)) return true;
            }
        }
    }
    return false;
}

/** Find the nearest solid (non-leaves) stance near a log in a tree crown */
function findSolidStanceNearTree(bot: Bot, logPos: Vec3, maxRadius: number): Vec3 | null {
    // Search in expanding rings, prefering lower Y and solid ground
    for (let radius = 1; radius <= maxRadius; radius++) {
        for (let dy = 0; dy >= -3; dy--) {
            const y = logPos.y + dy;
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    if (Math.abs(dx) < radius && Math.abs(dz) < radius && radius > 1) continue; // ring only
                    const testPos = { x: logPos.x + dx, y, z: logPos.z + dz };
                    const footing = bot.blockAt({ x: testPos.x, y: testPos.y - 1, z: testPos.z } as any);
                    if (!footing || footing.name === 'air' || isLeaves(footing) || isLiquid(footing)) continue;
                    // Check head clearance
                    const head = bot.blockAt({ x: testPos.x, y: testPos.y + 1, z: testPos.z } as any);
                    if (head && head.name !== 'air' && !isWater(head)) continue;
                    // Check stance block
                    const stanceB = bot.blockAt(testPos as any);
                    if (stanceB && stanceB.name !== 'air' && !isWater(stanceB)) continue;
                    return testPos;
                }
            }
        }
    }
    return null;
}

// ─── Main entry point ───────────────────────────────────

/**
 * Choose the best dig stance for a target block.
 *
 * Core logic:
 * 1. Classify relative position of target vs bot
 * 2. Enumerate candidates around the target
 * 3. For tree/leaves cases, apply special penalty logic
 * 4. For under_feet, never recommend standing on the target
 * 5. Return the best valid stance or a clear failure reason
 */
export function chooseDigStance(
    bot: Bot,
    targetBlock: any,
    config?: Partial<DigStancePlannerConfig>,
): DigStanceResult {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const botPos = bot.entity?.position;

    // ─── NaN guard ───────────────────────────────────
    if (!isFiniteVec3(botPos)) {
        return {
            ok: false,
            relativeType: 'unreachable_geometry',
            target: { x: 0, y: 0, z: 0, name: targetBlock?.name },
            reason: 'position_health_disallows_dig',
            debug: { botPosition: { x: 0, y: 0, z: 0 }, examinedCandidates: 0, rejected: [] },
        };
    }

    const tp = targetBlock?.position;
    if (!isFiniteVec3(tp)) {
        return {
            ok: false,
            relativeType: 'unreachable_geometry',
            target: { x: 0, y: 0, z: 0, name: targetBlock?.name },
            reason: 'target_lost_before_dig',
            debug: { botPosition: floorVec3(botPos), examinedCandidates: 0, rejected: ['target position invalid'] },
        };
    }

    const targetVec = { x: tp.x, y: tp.y, z: tp.z };
    const relativeType = classifyDigRelativeType(botPos, targetVec);

    const debug: DigStanceResult['debug'] = {
        botPosition: floorVec3(botPos),
        examinedCandidates: 0,
        rejected: [],
    };

    // ─── under_feet special handling ──────────────────
    // Must NEVER recommend standing directly on top of the target
    if (relativeType === 'under_feet') {
        // Check if bot is currently standing directly on the target
        const botFloor = floorVec3(botPos);
        if (botFloor.x === tp.x && botFloor.z === tp.z && botFloor.y === tp.y + 1) {
            debug.rejected.push('bot_standing_on_target_under_feet');
            // Look for a side stance around the target
            const sideCandidates = enumerateDigStanceCandidates(bot, targetBlock, {
                ...cfg,
                maxBotToStanceDistance: 5,
            }).filter(c => {
                const cy = c.position.y;
                return cy === tp.y || cy === tp.y - 1 || cy === tp.y + 1;
            });

            if (sideCandidates.length > 0) {
                return {
                    ok: true,
                    relativeType,
                    target: { x: tp.x, y: tp.y, z: tp.z, name: targetBlock.name },
                    stance: sideCandidates[0],
                    alternatives: sideCandidates.slice(1, 4),
                    debug: { ...debug, examinedCandidates: sideCandidates.length + 1 },
                };
            }

            return {
                ok: false,
                relativeType,
                target: { x: tp.x, y: tp.y, z: tp.z, name: targetBlock.name },
                reason: 'target_under_feet',
                debug: { ...debug, examinedCandidates: 0, rejected: [...debug.rejected, 'no_side_stance_for_under_feet'] },
            };
        }
    }

    // ─── Enumerate candidates ─────────────────────────
    const allCandidates = enumerateDigStanceCandidates(bot, targetBlock, cfg);
    debug.examinedCandidates = allCandidates.length;

    // ─── Filter candidates ────────────────────────────
    const valid = allCandidates.filter((c) => {
        if (c.riskyFooting && !cfg.allowLeafFooting && !cfg.allowEdgeFooting) {
            debug.rejected.push(`risky:${c.position.x},${c.position.y},${c.position.z}`);
            return false;
        }
        if (c.distanceToTarget > cfg.maxTargetReachDistance) {
            debug.rejected.push(`too_far:${c.position.x},${c.position.y},${c.position.z}`);
            return false;
        }
        if (c.requiresJumpLook && c.riskyFooting) {
            debug.rejected.push(`jump_look_risky:${c.position.x},${c.position.y},${c.position.z}`);
            return false;
        }
        return true;
    });

    // ─── Tree / Leaves special handling ───────────────
    const targetIsLog = isLog(targetBlock);
    const targetInTree = targetIsLog && hasNearbyLeaves(bot, tp);

    if (targetIsLog && targetInTree && ['below', 'diagonal_below', 'under_feet'].includes(relativeType)) {
        // Check if bot is currently on leaves
        const botFloor = floorVec3(botPos);
        const currentFooting = bot.blockAt({ x: botFloor.x, y: botFloor.y - 1, z: botFloor.z } as any);

        if (isLeaves(currentFooting)) {
            debug.rejected.push('bot_on_leaves_digging_log');

            // Try to find a solid stance near the tree
            const solidStance = findSolidStanceNearTree(bot, tp, cfg.maxHorizontalRadius);
            if (solidStance) {
                // Re-evaluate with solid stance as preferred
                const relAtStance = classifyDigRelativeType(solidStance, targetVec);
                const evaluatedStance = evaluateDigStanceCandidate(bot, targetBlock, solidStance, relAtStance, cfg);
                if (evaluatedStance) {
                    // Boost this stance to prioritize it
                    evaluatedStance.score += 200;
                    evaluatedStance.reasons.push('solid_stance_near_tree_crown');
                    const alternatives = valid.filter(v =>
                        v.position.x !== solidStance.x
                        || v.position.y !== solidStance.y
                        || v.position.z !== solidStance.z
                    ).slice(0, 3);

                    return {
                        ok: true,
                        relativeType,
                        target: { x: tp.x, y: tp.y, z: tp.z, name: targetBlock.name },
                        stance: evaluatedStance,
                        alternatives,
                        debug,
                    };
                }
            }

            // No solid stance found — return unsafe_footing
            const bestLeaf = valid.length > 0 ? valid[0] : undefined;
            return {
                ok: false,
                relativeType,
                target: { x: tp.x, y: tp.y, z: tp.z, name: targetBlock.name },
                reason: 'unsafe_footing',
                stance: bestLeaf,
                alternatives: valid.slice(1, 4),
                debug: { ...debug, rejected: [...debug.rejected, 'no_solid_stance_near_tree'] },
            };
        }
    }

    // ─── Penalize standing on leaves for log targets ──
    const logFiltered = targetIsLog ? valid.filter(c => {
        const footingAtStance = bot.blockAt({ x: c.position.x, y: c.position.y - 1, z: c.position.z } as any);
        if (isLeaves(footingAtStance)) {
            // Keep but heavily penalize for log digging
            c.score -= 150;
            c.reasons.push('log_target_penalty_leaf_footing');
            return true;
        }
        return true;
    }) : valid;

    // ─── If no candidates at all ──────────────────────
    if (logFiltered.length === 0) {
        return {
            ok: false,
            relativeType,
            target: { x: tp.x, y: tp.y, z: tp.z, name: targetBlock.name },
            reason: 'no_dig_stance',
            debug,
            alternatives: allCandidates.slice(0, 3),
        };
    }

    // ─── Head clearance check for above/over_head ─────
    if (relativeType === 'above' || relativeType === 'over_head' || relativeType === 'diagonal_above') {
        const withHeadRoom = logFiltered.filter(c => {
            const headAtStance = bot.blockAt({ x: c.position.x, y: c.position.y + 1, z: c.position.z } as any);
            return !headAtStance || headAtStance.name === 'air' || isWater(headAtStance);
        });
        if (withHeadRoom.length === 0) {
            return {
                ok: false,
                relativeType,
                target: { x: tp.x, y: tp.y, z: tp.z, name: targetBlock.name },
                reason: 'head_clearance_blocked',
                alternatives: logFiltered.slice(0, 3),
                debug: { ...debug, rejected: [...debug.rejected, 'no_head_clearance_for_above'] },
            };
        }
        // Re-sort by score
        withHeadRoom.sort((a, b) => b.score - a.score);
        return {
            ok: true,
            relativeType,
            target: { x: tp.x, y: tp.y, z: tp.z, name: targetBlock.name },
            stance: withHeadRoom[0],
            alternatives: withHeadRoom.slice(1, 4),
            debug,
        };
    }

    // ─── Best stance selection ────────────────────────
    logFiltered.sort((a, b) => b.score - a.score);
    const best = logFiltered[0];
    return {
        ok: true,
        relativeType,
        target: { x: tp.x, y: tp.y, z: tp.z, name: targetBlock.name },
        stance: best,
        alternatives: logFiltered.slice(1, 4),
        debug,
    };
}

// ─── Post-stance validation ─────────────────────────────

/**
 * Validate the CURRENT stance for digging a target.
 * Called AFTER moving to stance, right before dig.
 */
export function validateCurrentStanceForDig(
    bot: Bot,
    targetBlock: any,
    config?: Partial<DigStancePlannerConfig>,
): { ok: boolean; reason?: DigStanceFailReason } {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const pos = bot.entity?.position;

    if (!isFiniteVec3(pos)) {
        return { ok: false, reason: 'position_health_disallows_dig' };
    }

    // Check target still exists
    if (!targetBlock) {
        return { ok: false, reason: 'target_lost_before_dig' };
    }
    const current = bot.blockAt(targetBlock.position);
    if (!current || current.name !== targetBlock.name) {
        return { ok: false, reason: 'target_lost_before_dig' };
    }

    // Check reach
    const dist = distance(bot.entity.position, targetBlock.position);
    if (dist > cfg.maxTargetReachDistance) {
        return { ok: false, reason: 'target_out_of_reach' };
    }

    // Check footing
    const floorPos = floorVec3(pos);
    const footingPos = { x: floorPos.x, y: floorPos.y - 1, z: floorPos.z };
    const footing = bot.blockAt(footingPos as any);

    if (!cfg.allowEdgeFooting && (!footing || footing.name === 'air')) {
        return { ok: false, reason: 'unsafe_footing' };
    }
    if (footing?.name === 'lava') {
        return { ok: false, reason: 'unsafe_footing' };
    }
    if (isLeaves(footing) && !cfg.allowLeafFooting) {
        return { ok: false, reason: 'unsafe_footing' };
    }

    // Check head clearance
    const headPos = { x: floorPos.x, y: floorPos.y + 1, z: floorPos.z };
    const headBlock = bot.blockAt(headPos as any);
    if (headBlock && headBlock.name !== 'air' && !isWater(headBlock)) {
        // Allow digging above if head is slightly blocked (bot will look up)
        const relType = classifyDigRelativeType(pos, targetBlock.position);
        if (relType !== 'above' && relType !== 'diagonal_above' && relType !== 'over_head') {
            return { ok: false, reason: 'head_clearance_blocked' };
        }
    }

    // Line of sight: check if there's a solid block directly between eyes and target
    const targetCenter = {
        x: targetBlock.position.x + 0.5,
        y: targetBlock.position.y + 0.5,
        z: targetBlock.position.z + 0.5,
    };
    const midX = Math.floor((pos.x + targetCenter.x) / 2);
    const midY = Math.floor((pos.y + 1.5 + targetCenter.y) / 2); // eye height ~1.5
    const midZ = Math.floor((pos.z + targetCenter.z) / 2);
    const midBlock = bot.blockAt({ x: midX, y: midY, z: midZ } as any);
    if (midBlock && midBlock.name !== 'air'
        && (midBlock.position.x !== targetBlock.position.x
            || midBlock.position.y !== targetBlock.position.y
            || midBlock.position.z !== targetBlock.position.z)) {
        // Midpoint is a solid block that's not the target — line of sight blocked
        // But allow if it's diggable and distance is close
        if (dist <= 2.5) {
            return { ok: true, reason: undefined };
        }
        return { ok: false, reason: 'line_of_sight_blocked' };
    }

    return { ok: true, reason: undefined };
}

/**
 * Skill Gap Detector
 *
 * Analyzes failure patterns from Memory, classifies each cluster
 * into one of 6 categories. Pure rule-based — no LLM.
 * Outputs GapReport for human consumption and planner feedback.
 */
import fs from 'fs';
import path from 'path';
import type { Memory } from './memory.js';
import type {
    MemoryEntry,
    FailureCluster,
    GapFinding,
    GapReport,
    GapCategory,
    GapRecommendedAction,
} from '../types/index.js';

export interface GapDetectorConfig {
    minSamples: number;
    analysisIntervalMs: number;
    minConfidenceNoise: number;
    minConfidencePrecondition: number;
    minConfidenceParam: number;
    minConfidenceRecovery: number;
    minConfidencePlanner: number;
    minConfidenceSkillGap: number;
    skillGapMinCount: number;
    preconditionMaxElapsedMs: number;
    paramIssueMinFailRate: number;
    maxRetriesForSkillGap: number;
}

const DEFAULT_CONFIG: GapDetectorConfig = {
    minSamples: 3,
    analysisIntervalMs: 300000,
    minConfidenceNoise: 0.9,
    minConfidencePrecondition: 0.85,
    minConfidenceParam: 0.8,
    minConfidenceRecovery: 0.7,
    minConfidencePlanner: 0.75,
    minConfidenceSkillGap: 0.6,
    skillGapMinCount: 5,
    preconditionMaxElapsedMs: 2000,
    paramIssueMinFailRate: 0.6,
    maxRetriesForSkillGap: 3,
};

export class GapDetector {
    private memory: Memory;
    private config: GapDetectorConfig;
    private lastReport: GapReport | null = null;

    constructor(memory: Memory, config?: Partial<GapDetectorConfig>) {
        this.memory = memory;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    get latestReport(): GapReport | null {
        return this.lastReport;
    }

    /** Analyze failures in the given time window (default 10 min) */
    analyze(windowMs = 600000): GapReport {
        const now = Date.now();
        const failures = this.memory.getFailuresInWindow(windowMs);
        const successes = this.memory.getSuccessesInWindow(windowMs);

        const clusters = this.clusterFailures(failures, successes);
        const findings: GapFinding[] = [];

        for (const cluster of clusters) {
            if (cluster.count < this.config.minSamples) continue;
            const reasons: string[] = [];
            const category = this.classify(cluster, failures.length, successes.length, reasons);
            if (category === 'environment_noise') continue;
            findings.push(this.buildFinding(cluster, category, reasons));
        }

        findings.sort((a, b) => b.confidence - a.confidence);

        const report: GapReport = {
            timestamp: now,
            windowMs,
            totalFails: failures.length,
            totalSuccesses: successes.length,
            findings,
        };

        this.lastReport = report;
        return report;
    }

    /** Periodic check — stores report in memory if findings exist */
    async tick(): Promise<void> {
        const report = this.analyze(this.config.analysisIntervalMs);
        if (report.findings.length > 0) {
            this.memory.recordGapReport(report);
            console.log(this.formatReport(report));
            this.appendJsonl(report);
        }
    }

    private appendJsonl(report: GapReport): void {
        try {
            const logsDir = path.join(process.cwd(), 'logs');
            if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
            const line = JSON.stringify(report) + '\n';
            fs.appendFileSync(path.join(logsDir, 'gap-reports.jsonl'), line);
        } catch {
            // silently ignore write errors
        }
    }

    /** Human-readable report */
    formatReport(report: GapReport): string {
        const now = report.timestamp;
        const failRate = report.totalFails + report.totalSuccesses > 0
            ? ((report.totalFails / (report.totalFails + report.totalSuccesses)) * 100).toFixed(0)
            : '0';

        let out = `\n=== Skill Gap Report (${new Date(now).toISOString().slice(0, 19)}) ===\n`;
        out += `Window: ${(report.windowMs / 60000).toFixed(0)}min | ${report.totalFails} fails / ${report.totalSuccesses} success = ${failRate}%\n`;

        const categories = ['no_gap_param_issue', 'no_gap_recovery_issue', 'no_gap_precondition', 'no_gap_planner_issue', 'skill_gap'] as const;
        const labels: Record<string, string> = {
            no_gap_param_issue: 'PARAM ISSUES',
            no_gap_recovery_issue: 'RECOVERY ISSUES',
            no_gap_precondition: 'PRECONDITION ISSUES',
            no_gap_planner_issue: 'PLANNER ISSUES',
            skill_gap: 'SKILL GAPS',
        };

        for (const cat of categories) {
            const items = report.findings.filter((f) => f.category === cat);
            if (items.length === 0) continue;
            out += `\n--- ${labels[cat]} ---\n`;
            for (const f of items) {
                out += `  [${f.actionKey}] ${f.failureType} (${f.evidence.count}x, ${(f.evidence.failRate * 100).toFixed(0)}% fail)\n`;
                out += `    ${f.summary}\n`;
                out += `    → ${f.recommendedAction}`;
                if (f.candidateParams) {
                    out += ` | params: ${JSON.stringify(f.candidateParams)}`;
                }
                if (f.candidateSkillName) {
                    out += ` | skill: ${f.candidateSkillName}`;
                }
                out += `\n    reason: ${f.debugReason.join(' → ')}\n`;
            }
        }

        if (report.findings.length === 0) {
            out += '\n  No significant failure patterns detected.\n';
        }
        return out;
    }

    // ─── Clustering ──────────────────────────────────────

    private clusterFailures(failures: MemoryEntry[], successes: MemoryEntry[]): FailureCluster[] {
        const clusterMap = new Map<string, {
            actionKey: string;
            failureType: string;
            targetKey?: string;
            source?: string;
            count: number;
            totalElapsed: number;
            totalRetries: number;
            samples: string[];
            dayCount: number;
            nightCount: number;
        }>();

        for (const entry of failures) {
            const ctx = entry.context as Record<string, unknown>;
            const actionKey = (ctx?.taskType as string) ?? (ctx?.actionKey as string) ?? 'unknown';
            const failureType = (ctx?.failureType as string) ?? 'unknown';
            const targetKey = (ctx?.target as string) || ((ctx?.params as Record<string, unknown>)?.target as string) || undefined;
            const source = ctx?.source as string || undefined;

            // Cluster key: actionKey + failureType + targetKey (if present)
            const key = targetKey
                ? `${actionKey}::${failureType}::${targetKey}`
                : `${actionKey}::${failureType}`;

            let cluster = clusterMap.get(key);
            if (!cluster) {
                cluster = {
                    actionKey,
                    failureType,
                    targetKey,
                    source,
                    count: 0,
                    totalElapsed: 0,
                    totalRetries: 0,
                    samples: [],
                    dayCount: 0,
                    nightCount: 0,
                };
                clusterMap.set(key, cluster);
            }

            cluster.count++;
            cluster.totalElapsed += (ctx?.elapsedMs as number) ?? 0;
            cluster.totalRetries += (ctx?.retries as number) ?? 0;
            cluster.samples.push(entry.summary);
            if (cluster.samples.length > 5) cluster.samples = cluster.samples.slice(-5);

            // Time of day heuristics
            if (ctx?.timeOfDay === 'night') {
                cluster.nightCount++;
            } else {
                cluster.dayCount++;
            }
        }

        // Count successes per actionKey
        const successByKey = new Map<string, number>();
        for (const entry of successes) {
            const actionKey = (entry.context?.taskType as string) ?? entry.context?.actionKey as string ?? 'unknown';
            const targetKey = entry.context?.target as string || entry.context?.params?.target as string || undefined;
            const key = targetKey
                ? `${actionKey}::${targetKey}`
                : actionKey;
            successByKey.set(key, (successByKey.get(key) ?? 0) + 1);
        }

        return [...clusterMap.values()].map((c) => {
            const successKey = c.targetKey
                ? `${c.actionKey}::${c.targetKey}`
                : c.actionKey;
            const successCount = successByKey.get(successKey) ?? 0;
            const total = c.count + successCount;
            const failRate = total > 0 ? c.count / total : 1;

            return {
                actionKey: c.actionKey,
                failureType: c.failureType,
                targetKey: c.targetKey,
                source: c.source,
                count: c.count,
                successCount,
                failRate,
                avgElapsedMs: c.count > 0 ? c.totalElapsed / c.count : 0,
                avgRetries: c.count > 0 ? c.totalRetries / c.count : 0,
                timeOfDay: { day: c.dayCount, night: c.nightCount },
                samples: c.samples,
            };
        });
    }

    // ─── 6-Level Classification Chain ────────────────────
    // Execute in order; first match wins.

    private classify(
        c: FailureCluster,
        totalFails: number,
        totalSuccesses: number,
        reasons: string[],
    ): GapCategory {
        if (this.isNoise(c, reasons)) return 'environment_noise';
        if (this.isPrecondition(c, reasons)) return 'no_gap_precondition';
        if (this.isParamIssue(c, reasons)) return 'no_gap_param_issue';
        if (this.isRecoveryIssue(c, reasons)) return 'no_gap_recovery_issue';
        if (this.isPlannerIssue(c, reasons)) return 'no_gap_planner_issue';
        if (this.isSkillGap(c, reasons)) return 'skill_gap';
        reasons.push('no category matched → environment_noise');
        return 'environment_noise';
    }

    // 1. Noise: too few samples or too scattered
    private isNoise(c: FailureCluster, reasons: string[]): boolean {
        if (c.count < this.config.minSamples) {
            reasons.push(`noise: count=${c.count} < minSamples(${this.config.minSamples})`);
            return true;
        }
        return false;
    }

    // 2. Precondition: fast rejection (elapsed < 2s) with not_possible / no_resource
    private isPrecondition(c: FailureCluster, reasons: string[]): boolean {
        const preconditionTypes = ['not_possible', 'no_resource', 'blocked'];
        if (!preconditionTypes.includes(c.failureType)) {
            reasons.push(`precondition: failType=${c.failureType} not in [${preconditionTypes}]`);
            return false;
        }
        if (c.avgElapsedMs < this.config.preconditionMaxElapsedMs) {
            reasons.push(`precondition: elapsed=${c.avgElapsedMs.toFixed(0)}ms < ${this.config.preconditionMaxElapsedMs}ms, failType=${c.failureType}`);
            return true;
        }
        reasons.push(`precondition: elapsed=${c.avgElapsedMs.toFixed(0)}ms >= ${this.config.preconditionMaxElapsedMs}ms`);
        return false;
    }

    // 3. Param issue: timeout/path_stuck dominant, had successes before
    private isParamIssue(c: FailureCluster, reasons: string[]): boolean {
        const paramTypes = ['timeout', 'path_stuck'];
        if (!paramTypes.includes(c.failureType)) {
            reasons.push(`param: failType=${c.failureType} not in [${paramTypes}]`);
            return false;
        }
        if (c.failRate < this.config.paramIssueMinFailRate) {
            reasons.push(`param: failRate=${(c.failRate*100).toFixed(0)}% < ${(this.config.paramIssueMinFailRate*100).toFixed(0)}%`);
            return false;
        }
        if (c.successCount === 0) {
            reasons.push(`param: successCount=0 (need >0 for param classification)`);
            return false;
        }
        reasons.push(`param: failType=${c.failureType}, failRate=${(c.failRate*100).toFixed(0)}%, successCount=${c.successCount}`);
        return true;
    }

    // 4. Recovery issue: target_lost/path_stuck with successes, fewer than skill gap count
    private isRecoveryIssue(c: FailureCluster, reasons: string[]): boolean {
        const recoveryTypes = ['target_lost', 'path_stuck'];
        if (!recoveryTypes.includes(c.failureType)) {
            reasons.push(`recovery: failType=${c.failureType} not in [${recoveryTypes}]`);
            return false;
        }
        if (c.successCount === 0) {
            reasons.push(`recovery: successCount=0`);
            return false;
        }
        if (c.count < this.config.skillGapMinCount) {
            reasons.push(`recovery: failType=${c.failureType}, successCount=${c.successCount}, count=${c.count} < ${this.config.skillGapMinCount}`);
            return true;
        }
        if (c.avgRetries < this.config.maxRetriesForSkillGap) {
            reasons.push(`recovery: failType=${c.failureType}, successCount=${c.successCount}, avgRetries=${c.avgRetries.toFixed(1)} < ${this.config.maxRetriesForSkillGap}`);
            return true;
        }
        reasons.push(`recovery: count=${c.count} >= ${this.config.skillGapMinCount}, avgRetries=${c.avgRetries.toFixed(1)} >= ${this.config.maxRetriesForSkillGap}`);
        return false;
    }

    // 5. Planner issue: source includes planner, failure is blocked/not_possible
    private isPlannerIssue(c: FailureCluster, reasons: string[]): boolean {
        const plannerTypes = ['blocked', 'not_possible'];
        if (!plannerTypes.includes(c.failureType)) {
            reasons.push(`planner: failType=${c.failureType} not in [${plannerTypes}]`);
            return false;
        }
        if (!c.source?.includes('planner')) {
            reasons.push(`planner: source=${c.source ?? 'undefined'} does not include 'planner'`);
            return false;
        }
        reasons.push(`planner: source=${c.source}, failType=${c.failureType}, count=${c.count}`);
        return true;
    }

    // 6. Skill gap: persistent failures NOT explained by above categories
    private isSkillGap(c: FailureCluster, reasons: string[]): boolean {
        if (c.count < this.config.skillGapMinCount) {
            reasons.push(`skill_gap: count=${c.count} < ${this.config.skillGapMinCount}`);
            return false;
        }
        if (c.successCount > 0) {
            reasons.push(`skill_gap: successCount=${c.successCount} > 0`);
            return false;
        }
        const paramTypes = ['timeout'];
        if (paramTypes.includes(c.failureType)) {
            reasons.push(`skill_gap: failType=${c.failureType} is param-type`);
            return false;
        }
        reasons.push(`skill_gap: count=${c.count} >= ${this.config.skillGapMinCount}, successCount=0, failType=${c.failureType}`);
        return true;
    }

    // ─── Finding builder ─────────────────────────────────

    private buildFinding(c: FailureCluster, category: GapCategory, debugReason: string[]): GapFinding {
        const { summary, recommendedAction, candidateParams, candidateSkillName } =
            this.describeFinding(c, category);

        return {
            category,
            confidence: this.getConfidence(category),
            actionKey: c.actionKey,
            failureType: c.failureType,
            targetKey: c.targetKey,
            summary,
            recommendedAction,
            candidateParams,
            candidateSkillName,
            debugReason,
            evidence: {
                count: c.count,
                failRate: c.failRate,
                avgElapsedMs: c.avgElapsedMs,
                avgRetries: c.avgRetries,
            },
        };
    }

    private describeFinding(
        c: FailureCluster,
        category: GapCategory,
    ): {
        summary: string;
        recommendedAction: GapRecommendedAction;
        candidateParams?: Record<string, number>;
        candidateSkillName?: string;
    } {
        const targetStr = c.targetKey ? ` for "${c.targetKey}"` : '';
        const countStr = `${c.count}x, ${(c.failRate * 100).toFixed(0)}% fail rate`;

        switch (category) {
            case 'no_gap_param_issue': {
                const param: Record<string, number> = {};
                if (c.failureType === 'timeout') {
                    param.timeoutMs = Math.round(c.avgElapsedMs * 1.5);
                }
                return {
                    summary: `Task ${c.actionKey}${targetStr} failing due to ${c.failureType} — ${countStr}`,
                    recommendedAction: c.failureType === 'timeout' ? 'increase_timeout' : 'tune_retry_limit',
                    candidateParams: param,
                };
            }

            case 'no_gap_recovery_issue':
                return {
                    summary: `Task ${c.actionKey}${targetStr} fails with ${c.failureType} despite prior successes — ${countStr}`,
                    recommendedAction: 'add_recovery_branch',
                };

            case 'no_gap_precondition':
                return {
                    summary: `Task ${c.actionKey}${targetStr} rejected instantly (${c.avgElapsedMs.toFixed(0)}ms) — ${countStr}`,
                    recommendedAction: 'add_precondition_check',
                };

            case 'no_gap_planner_issue':
                return {
                    summary: `Planner attempted impossible task ${c.actionKey}${targetStr} — ${countStr}`,
                    recommendedAction: 'adjust_planner_rule',
                };

            case 'skill_gap': {
                const capPhrase = this.inferCapabilityGap(c);
                const name = this.mapCapabilityToName(capPhrase);
                return {
                    summary: `Repeated ${c.actionKey}${targetStr} failures suggest a missing capability: ${capPhrase}`,
                    recommendedAction: 'propose_new_skill',
                    candidateSkillName: name,
                };
            }

            default:
                return {
                    summary: `Unclassified pattern: ${c.actionKey} ${c.failureType} — ${countStr}`,
                    recommendedAction: 'ignore_for_now',
                };
        }
    }

    private getConfidence(category: GapCategory): number {
        switch (category) {
            case 'environment_noise': return this.config.minConfidenceNoise;
            case 'no_gap_precondition': return this.config.minConfidencePrecondition;
            case 'no_gap_param_issue': return this.config.minConfidenceParam;
            case 'no_gap_recovery_issue': return this.config.minConfidenceRecovery;
            case 'no_gap_planner_issue': return this.config.minConfidencePlanner;
            case 'skill_gap': return this.config.minConfidenceSkillGap;
        }
    }

    /** Infer a human-readable capability phrase from failure pattern */
    private inferCapabilityGap(c: FailureCluster): string {
        if (c.actionKey === 'move_to' && c.failureType === 'path_stuck') {
            if (c.samples.some((s) => s.toLowerCase().includes('water') || s.toLowerCase().includes('liquid'))) {
                return 'cross_water_body';
            }
            return 'escape_blocked_path';
        }
        if (c.actionKey === 'collect' && c.failureType === 'target_lost') {
            return 'reacquire_lost_target';
        }
        if (c.actionKey === 'pickup' && c.failureType === 'target_lost') {
            return 'reacquire_dropped_item';
        }
        if (c.actionKey === 'retreat' && c.failureType === 'path_stuck') {
            return 'find_safe_escape_route';
        }
        if (c.failureType === 'no_resource') {
            return `gather_${c.targetKey ?? 'resource'}`;
        }
        if (c.failureType === 'blocked') {
            return `navigate_around_${c.targetKey ?? 'obstacle'}`;
        }
        return `${c.actionKey}_${c.failureType}_recovery`;
    }

    /** Map capability phrase to a candidate skill name */
    private mapCapabilityToName(phrase: string): string | undefined {
        const map: Record<string, string> = {
            'cross_water_body': 'swim_to_land',
            'escape_blocked_path': 'escape_stuck',
            'reacquire_lost_target': 'reacquire_target',
            'reacquire_dropped_item': 'reacquire_item',
            'find_safe_escape_route': 'retreat_safe',
        };
        return map[phrase];
    }
}

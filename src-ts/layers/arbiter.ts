/**
 * Arbiter — Safety Veto Layer
 *
 * Validates Commander decisions before execution.
 * Cannot be overridden by LLM. Hard safety rules only.
 */
import type { CommanderDecision } from './commander.js';

export interface ArbiterInput {
    health: number;
    food: number;
    positionHealth: 'trusted' | 'degraded' | 'invalid';
    isReconnecting: boolean;
    hostileNearby: boolean;
    recentFailCount: number;
    hasFoodInInventory: boolean;
}

export interface ArbiterResult {
    approved: boolean;
    decision: CommanderDecision;
    vetoReason?: string;
    adjusted?: boolean;
}

export class Arbiter {
    validate(input: ArbiterInput, decision: CommanderDecision): ArbiterResult {
        // 1. Position invalid → only allow recovery
        if (input.positionHealth === 'invalid') {
            return {
                approved: false,
                decision,
                vetoReason: 'PositionHealth invalid — cannot execute any task',
            };
        }

        // 2. Reconnecting → idle only
        if (input.isReconnecting) {
            return {
                approved: decision.mode === 'idle',
                decision,
                vetoReason: decision.mode !== 'idle' ? 'Reconnecting — forced idle' : undefined,
            };
        }

        // 3. Low health → force recovery, veto anything else
        if (input.health <= 4 && decision.mode !== 'recover') {
            return {
                approved: false,
                decision,
                vetoReason: `Health ${input.health} critical — only recovery allowed`,
            };
        }

        // 4. Food critical → inject eat task
        if (input.food <= 6 && decision.mode !== 'recover' && decision.mode !== 'idle') {
            if (input.hasFoodInInventory) {
                decision.tasks.unshift({
                    type: 'eat',
                    params: {},
                    priority: 100,
                });
                return {
                    approved: true,
                    decision,
                    adjusted: true,
                    vetoReason: undefined,
                };
            }
        }

        // 5. Hostile nearby + low health → veto gather/explore
        if (input.hostileNearby && input.health <= 10) {
            const riskyTasks = decision.tasks.filter(t =>
                t.type === 'collect' || t.type === 'move_to'
            );
            if (riskyTasks.length > 0 && decision.mode !== 'recover') {
                return {
                    approved: false,
                    decision: { ...decision, mode: 'recover', tasks: [], reason: 'Hostile nearby, low health' },
                    vetoReason: `Hostile ${input.hostileNearby} and health ${input.health} — vetoed risky tasks`,
                };
            }
        }

        // 6. Too many failures → force idle/generate_spec
        if (input.recentFailCount >= 5 && decision.mode === 'switch_goal') {
            return {
                approved: false,
                decision: { ...decision, mode: 'idle', tasks: [], reason: 'Too many recent failures' },
                vetoReason: `${input.recentFailCount} recent failures — cooling down`,
            };
        }

        return { approved: true, decision };
    }
}

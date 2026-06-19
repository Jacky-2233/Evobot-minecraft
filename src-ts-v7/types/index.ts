export interface Vec3 { x: number; y: number; z: number }

export type FailureType = 'timeout' | 'blocked' | 'no_resource' | 'target_lost' | 'path_stuck' | 'not_possible' | 'cancelled' | 'internal_error';

export interface SkillResult {
  ok: boolean;
  detail: string;
  failureType?: FailureType;
}

export interface ISkill<P = unknown> {
  readonly name: string;
  readonly defaultTimeoutMs: number;
  run(params: P): Promise<SkillResult>;
  cancel(): void;
}

export interface BotConfig {
  host: string; port: number; username: string; version: string; auth: 'offline' | 'microsoft';
  updateIntervalMs: number; autoReconnect: boolean;
  hungerThreshold: number; lowHealthThreshold: number; criticalHealthThreshold: number;
  stuckTimeoutMs: number;
  ai: { apiKey: string; baseURL: string; model: string; maxTokens: number; timeoutMs: number };
}

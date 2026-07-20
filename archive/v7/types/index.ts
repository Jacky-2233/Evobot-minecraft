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

export interface ProviderConfig {
  baseURL: string;
  apiKey?: string;
  apiKeyFile?: string;
}

export interface AIConfig {
  provider: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  providers: Record<string, ProviderConfig>;
  /** @deprecated legacy: unified apiKey, auto-wrapped into providers */
  apiKey?: string;
  /** @deprecated legacy: unified baseURL, auto-wrapped into providers */
  baseURL?: string;
}

export interface BotConfig {
  backend?: 'mineflayer' | 'mc-api';
  host: string; port: number; username: string; version: string; auth: 'offline' | 'microsoft';
  updateIntervalMs: number; autoReconnect: boolean;
  hungerThreshold: number; lowHealthThreshold: number; criticalHealthThreshold: number;
  stuckTimeoutMs: number;
  ai: AIConfig;
}

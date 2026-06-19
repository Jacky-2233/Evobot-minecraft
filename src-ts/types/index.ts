/**
 * EvoBot v6 Type System
 *
 * All types are defined here first. No circular imports.
 * Every skill returns a SkillResult.
 * Every task goes through the Executor.
 */

// ─── Vec3 ───────────────────────────────────────────────
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ─── Skill Result ────────────────────────────────────────
/** Every skill must return this. `ok: false` triggers recovery. */
export interface SkillResult {
  ok: boolean;
  detail: string;
  /** Optional structured payload for chaining */
  payload?: unknown;
  /** If failed, what kind of failure */
  failureType?: FailureType;
}

/** Categorised failure for recovery logic */
export type FailureType =
  | 'timeout'
  | 'blocked'
  | 'no_resource'
  | 'target_lost'
  | 'path_stuck'
  | 'not_possible'
  | 'cancelled'
  | 'internal_error';

// ─── Skill Interface ─────────────────────────────────────
export interface ISkill<P = unknown> {
  /** Unique name, e.g. "move_to" */
  readonly name: string;
  readonly description: string;
  /** Can this skill be interrupted safely */
  readonly interruptible: boolean;
  /** Default timeout in ms */
  readonly defaultTimeoutMs: number;
  /** Default max retries */
  readonly maxRetries: number;

  /** Execute the skill (wraps _execute with timeout/retry) */
  run(params: P, timeoutMs?: number, retries?: number): Promise<SkillResult>;
  /** Cancel current execution */
  cancel(): void;
  /** Whether the skill is currently executing */
  readonly isRunning: boolean;
}

// ─── Skill Context ───────────────────────────────────────
/** Injected into every skill execution. */
export interface SkillContext {
  /** Absolute time this skill was started */
  startedAt: number;
  /** Deadline (startedAt + timeout) */
  deadline: number;
  /** Abort signal */
  signal: AbortSignal;
  /** Structured logging method */
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

// ─── Task ────────────────────────────────────────────────
export interface TaskDefinition {
  id: string;
  type: string;
  params: Record<string, unknown>;
  priority: number;
  createdAt: number;
  expiresAt?: number;
  source: 'ai' | 'console' | 'idle' | 'planner' | 'behavior' | 'step_executor';
  /** Optional goal this task belongs to */
  goalId?: string;
}

export interface TaskResult {
  task: TaskDefinition;
  result: SkillResult;
  elapsedMs: number;
  retries: number;
}

// ─── World State ─────────────────────────────────────────
export interface WorldStateSummary {
  position: Vec3;
  health: number;
  food: number;
  onGround: boolean;
  timeOfDay: 'day' | 'sunset' | 'night';
  nearbyHostile: EntitySummary[];
  nearbyPlayers: EntitySummary[];
  nearbyBlocks: BlockSummary[];
  inventorySlots: number;
  activeTask: string | null;
}

export interface EntitySummary {
  name: string;
  type: 'mob' | 'player' | 'animal' | 'item' | 'other';
  distance: number;
  position: Vec3;
}

export interface BlockSummary {
  name: string;
  count: number;
  positions: Vec3[];
}

// ─── Behavioral Priority ─────────────────────────────────
export type BehaviorPriority = number;
export const Priority = {
  SURVIVAL: 100,
  SAFETY: 90,
  STUCK_RECOVERY: 85,
  PLAYER_COMMAND: 70,
  IDLE_TASK: 30,
  EXPLORE: 10,
  IDLE: 0,
} as const;

// ─── Behavior Node ───────────────────────────────────────
export interface BehaviorNode {
  name: string;
  priority: BehaviorPriority;
  /** Returns true if this behavior should activate */
  condition: () => boolean;
  /** Execute the behavior, returns false if it should stop */
  tick: () => Promise<boolean>;
  cooldownMs: number;
}

// ─── Memory Entry ────────────────────────────────────────
export interface MemoryEntry {
  id: string;
  type: 'failure' | 'success' | 'location' | 'fact' | 'strategy';
  summary: string;
  context: Record<string, unknown>;
  timestamp: number;
  accessCount: number;
  importance: number;
}

// ─── Planner Types ───────────────────────────────────────
export interface Plan {
  goal: string;
  steps: PlanStep[];
  contingency?: Plan;
}

export interface PlanStep {
  skillName: string;
  params: Record<string, unknown>;
  maxRetries: number;
  timeoutMs: number;
  /** If this step fails, what to do */
  onFailure?: 'abort' | 'retry' | 'skip' | 'fallback';
  fallbackStep?: PlanStep;
}

// ─── Bot Configuration ───────────────────────────────────
export interface BotConfig {
  host: string;
  port: number;
  username: string;
  version: string;
  auth: 'offline' | 'microsoft';

  updateIntervalMs: number;
  autoReconnect: boolean;
  reconnectDelayMs: number;

  hungerThreshold: number;
  lowHealthThreshold: number;
  criticalHealthThreshold: number;

  stuckTimeoutMs: number;
  idleTimeoutMs: number;

  ai: {
    apiKey: string;
    baseURL: string;
    model: string;
    maxTokens: number;
    timeoutMs: number;
  };
}

// ─── Gap Detector Types ───────────────────────────────────
export type GapCategory =
  | 'no_gap_param_issue'
  | 'no_gap_recovery_issue'
  | 'no_gap_precondition'
  | 'no_gap_planner_issue'
  | 'skill_gap'
  | 'environment_noise';

export type GapRecommendedAction =
  | 'increase_timeout'
  | 'tune_retry_limit'
  | 'add_recovery_branch'
  | 'add_precondition_check'
  | 'adjust_planner_rule'
  | 'propose_new_skill'
  | 'ignore_for_now';

export interface FailureCluster {
  actionKey: string;
  failureType: string;
  targetKey?: string;
  source?: string;

  count: number;
  successCount: number;
  failRate: number;

  avgElapsedMs: number;
  avgRetries: number;

  timeOfDay?: {
    day: number;
    night: number;
  };

  samples: string[];
}

export interface GapFinding {
  category: GapCategory;
  confidence: number;

  actionKey: string;
  failureType: string;
  targetKey?: string;

  summary: string;
  recommendedAction: GapRecommendedAction;

  candidateParams?: Record<string, number>;
  candidateSkillName?: string;

  /** Rule chain that produced this classification */
  debugReason: string[];

  evidence: {
    count: number;
    failRate: number;
    avgElapsedMs: number;
    avgRetries: number;
  };
}

export interface GapReport {
  timestamp: number;
  windowMs: number;
  totalFails: number;
  totalSuccesses: number;
  findings: GapFinding[];
}

// ─── Skill Spec (for Spec Generator) ─────────────────────────
/** Structured specification for a new skill, derived from a skill_gap finding */
export interface SkillSpec {
  name: string;
  description: string;
  /** When this skill should activate (condition description) */
  trigger: string;
  /** What this skill should accomplish */
  goal: string;
  /** Requirements that must be true before execution */
  preconditions: string[];
  /** Ordered steps to accomplish the goal */
  steps: SkillSpecStep[];
  /** How to determine the skill succeeded */
  successCondition: string;
  /** Known reasons this skill might fail */
  failReasons: string[];
  /** Which existing skill it relates to (e.g. the one that keeps failing) */
  relatedActionKey: string;
  /** The gap finding that spawned this spec */
  sourceFinding?: {
    summary: string;
    evidenceCount: number;
    evidenceFailRate: number;
  };
}

// ─── Checkpoint (persist progress across disconnects) ─────────
export interface TaskCheckpoint {
  /** The original task type (e.g. 'collect') */
  type: string;
  /** Original params */
  params: Record<string, unknown>;
  /** How many units completed so far */
  completed: number;
  /** How many units were requested (e.g. count of 10) */
  target: number;
  /** When this task was first created */
  createdAt: number;
  /** Where the bot was when this task started */
  startPosition: Vec3;
  /** Source of the task */
  source: string;
  /** Optional goal this checkpoint belongs to */
  goalId?: string;
}

export interface Checkpoint {
  timestamp: number;
  botPosition: Vec3;
  inventory: string[];
  /** Current active task, if any */
  activeTask?: TaskCheckpoint;
  /** Current active goal, if any */
  activeGoalId?: string;
  /** Last few completed task summaries for context */
  recentCompletions: string[];
}

export interface SkillSpecStep {
  order: number;
  action: string;
  params?: Record<string, unknown>;
  description: string;
  /** What to do if this step fails */
  onFailure?: 'abort' | 'retry' | 'skip' | 'fallback';
}

// ─── Short-Step Executor Types ────────────────────────────────
/** A single atomic step in a step sequence. Must complete in <5s. */
export interface StepDefinition {
  /** Unique step ID (e.g. "scan_for_blocks", "move_to_block") */
  id: string;
  /** Human-readable step name */
  name: string;
  /** Step category for logging/metrics */
  type: StepType;
  /** The actual step logic */
  execute: (ctx: StepContext) => Promise<StepResult>;
  /** Max time for this step (should be <5s for 8s connection windows) */
  timeoutMs: number;
  /** Can this step be skipped on resume? (e.g. scan steps can be re-run) */
  canSkip: boolean;
  /** Steps that must complete before this one (dependency check) */
  dependsOn?: string[];
}

/** Step categories */
export type StepType = 'scan' | 'select' | 'move' | 'interact' | 'wait' | 'validate';

/** Context passed to each step execution */
export interface StepContext {
  /** The mineflayer bot instance */
  bot: any;
  /** Persistent state across steps (updated after each step) */
  state: StepState;
  /** Abort signal for cancellation */
  signal: AbortSignal;
  /** Structured logging method */
  log: (msg: string) => void;
  /** Current step index in the sequence */
  stepIndex: number;
  /** Total steps in the sequence */
  totalSteps: number;
}

/** Result returned by each step execution */
export interface StepResult {
  ok: boolean;
  /** State updates to persist (merged into StepState after execution) */
  state?: Partial<StepState>;
  detail: string;
  failureType?: FailureType;
}

/** Persistent state across steps (key-value store) */
export type StepState = Record<string, unknown>;

/** An ordered sequence of steps that form a skill */
export interface StepSequence {
  /** Unique sequence ID */
  id: string;
  /** Sequence name (e.g. "collect_jungle_log") */
  name: string;
  /** Ordered steps to execute */
  steps: StepDefinition[];
  /** Persistent state across steps */
  state: StepState;
  /** Current step index (0-based) */
  currentStepIndex: number;
  /** When this sequence was created */
  createdAt: number;
  /** Link to original task for checkpoint resume */
  originalTaskType?: string;
  /** Original task params for checkpoint resume */
  originalTaskParams?: Record<string, unknown>;
}

/** Checkpoint data for step-level progress tracking */
export interface StepCheckpoint {
  /** The sequence ID being executed */
  sequenceId: string;
  /** The sequence name */
  sequenceName: string;
  /** Current step index (next step to execute) */
  currentStepIndex: number;
  /** Persistent state across steps */
  state: StepState;
  /** IDs of completed steps */
  completedSteps: string[];
  /** Progress information */
  progress: {
    total: number;
    completed: number;
  };
  /** When this checkpoint was saved */
  savedAt: number;
  /** Link to original task for full task resume */
  originalTask?: TaskCheckpoint;
}

/** Enhanced checkpoint with step-level progress */
export interface EnhancedCheckpoint extends Checkpoint {
  /** Step-level checkpoint (if executing a step sequence) */
  stepCheckpoint?: StepCheckpoint;
}

// ─── Goal Types ──────────────────────────────────────────
export type GoalStatus = 'pending' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type GoalPriority = 'survival' | 'user' | 'autonomous';

export interface Goal {
  id: string;
  type: GoalPriority;
  description: string;
  status: GoalStatus;
  createdAt: number;
  activatedAt?: number;
  completedAt?: number;
  failReason?: string;
  /** Task IDs that belong to this goal */
  taskIds: string[];
  metadata: Record<string, unknown>;
}

/** Helper: Create a step definition */
export function createStep(
  id: string,
  name: string,
  type: StepType,
  execute: (ctx: StepContext) => Promise<StepResult>,
  timeoutMs = 3000,
  canSkip = false,
  dependsOn?: string[],
): StepDefinition {
  return { id, name, type, execute, timeoutMs, canSkip, dependsOn };
}

/** Helper: Create a step sequence */
export function createStepSequence(
  id: string,
  name: string,
  steps: StepDefinition[],
  state: StepState = {},
): StepSequence {
  return {
    id,
    name,
    steps,
    state,
    currentStepIndex: 0,
    createdAt: Date.now(),
  };
}

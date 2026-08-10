export type Sha256Digest = string;
export type ScoreSource = "deterministic" | "user" | "llm-judge";
export type MetricValueType = "boolean" | "number" | "category";

export interface SkillEvent {
  schema_version: 1;
  event_id: string;
  invocation_id: string;
  timestamp: string;
  event_type: "eligible" | "invoked" | "completed" | "cancelled" | "verified";
  skill_id: string;
  skill_version: string;
  skill_digest: Sha256Digest;
  skill_type: "capability" | "preference";
  host: string;
  host_version: string;
  model: string;
  model_version: string;
  harness_version: string;
  invocation_mode: "model" | "user" | "router" | "host" | "eval";
  session_id: string | null;
  route_id: string | null;
  eval_id: string | null;
  case_id: string | null;
  trial_id: string | null;
  provider: string | null;
  ablation_arm: "skill-on" | "skill-off" | "production" | null;
  trigger_expected: boolean | null;
  trigger_actual: boolean | null;
  provider_digest: Sha256Digest | null;
  eval_corpus_digest: Sha256Digest | null;
  trial_policy_digest: Sha256Digest | null;
  status: "succeeded" | "partial" | "failed" | "cancelled" | "handoff-required" | null;
  outcome_code: string | null;
  duration_ms: number;
  tool_calls: number;
  retries: number;
  rework_cycles: number;
  verification_checks: number;
  verification_passes: number;
  observation_source: "router" | "host-adapter" | "cli" | "eval-runner" | "user-report";
  source_aliases: string[];
  storage_scope: "local";
  append_only: true;
}

export interface NumericRange {
  min: number;
  max: number;
}

export interface BooleanMetricValue {
  value: boolean;
  utility: number;
}

export interface CategoryMetricValue {
  id: string;
  rank: number;
  passing: boolean;
  utility: number;
}

export type MetricPassRule =
  | { operator: "eq"; value: boolean | number | string }
  | { operator: "gte" | "lte"; value: number }
  | { operator: "between"; min: number; max: number };

export interface MetricLifecyclePolicy {
  minimum_trials_per_arm: number;
  minimum_comparable_environments: number;
  minimum_pass_rate: number;
  regression_tolerance: number;
  material_lift: number;
  non_inferiority_margin: number;
  efficiency_materiality: {
    duration_ms: number;
    retries: number;
    rework_cycles: number;
    tool_calls: number;
  };
}

export interface SkillMetric {
  schema_version: 1;
  metric_id: string;
  version: string;
  description: string;
  value_type: MetricValueType;
  number_range?: NumericRange;
  boolean_values?: BooleanMetricValue[];
  categories?: CategoryMetricValue[];
  direction: "maximize" | "minimize" | "target";
  target?: number;
  target_range?: NumericRange;
  pass_rule: MetricPassRule;
  eligible_score_sources: ScoreSource[];
  eligible_verification_codes: string[];
  lifecycle_policy: MetricLifecyclePolicy;
}

export interface SkillScore {
  schema_version: 1;
  score_id: string;
  timestamp: string;
  invocation_id: string;
  eval_id?: string;
  case_id?: string;
  trial_id?: string;
  metric_id: string;
  metric_definition_digest: Sha256Digest;
  value: boolean | number | string;
  value_type: MetricValueType;
  source: ScoreSource;
  grader_id: string;
  grader_version: string;
  rubric_digest: Sha256Digest;
  evidence_digests: Sha256Digest[];
  supersedes_score_id?: string;
  storage_scope: "local";
}

export interface SkillRollup {
  schema_version: 1;
  rollup_id: string;
  period: "daily" | "weekly";
  period_start: string;
  period_end: string;
  dimensions: {
    skill_id: string;
    skill_version: string;
    skill_digest: Sha256Digest;
    skill_type: "capability" | "preference";
    host: string;
    host_version: string;
    model: string;
    model_version: string;
    harness_version: string;
    invocation_mode: SkillEvent["invocation_mode"];
    provider: string | null;
    provider_digest: Sha256Digest | null;
    event_cohort: string;
    eval_corpus_digest: Sha256Digest | null;
    trial_policy_digest: Sha256Digest | null;
    metric_id: string | null;
    metric_definition_digest: Sha256Digest | null;
    rubric_digest: Sha256Digest | null;
    ablation_arm: SkillEvent["ablation_arm"];
  };
  counts: Record<"eligible" | "invoked" | "completed" | "cancelled" | "verified" | "incomplete", number>;
  sums: Record<"duration_ms" | "tool_calls" | "retries" | "rework_cycles" | "verification_checks" | "verification_passes", number>;
  histograms: Record<"duration_ms" | "tool_calls" | "retries" | "rework_cycles", number[]>;
  score_aggregate: { count: number; sum: number; utility_sum: number; pass_count: number; correction_count: number };
  observation_source_counts: Record<SkillEvent["observation_source"], number>;
  source_record_count: number;
  source_record_digest: Sha256Digest;
  sealed: boolean;
  storage_scope: "local";
}

export interface EvalCandidate {
  schema_version: 1;
  candidate_id: string;
  timestamp: string;
  skill_id: string;
  skill_digest: Sha256Digest;
  corpus_id: string;
  source_event_digests: Sha256Digest[];
  recommendation_digest?: Sha256Digest;
  failure_codes: string[];
  redacted_artifact_alias: string;
  redacted_artifact_digest: Sha256Digest;
  approval_status: "pending";
  storage_scope: "local";
  append_only: true;
}

export interface EvalCandidateApproval {
  schema_version: 1;
  approval_id: string;
  timestamp: string;
  candidate_id: string;
  candidate_digest: Sha256Digest;
  decision: "approved" | "rejected";
  approval_source: "user";
  reviewed_redacted_artifact_digest: Sha256Digest;
  storage_scope: "local";
  append_only: true;
}

export type ValidationErrorCode =
  | "SCHEMA_INVALID"
  | "METRIC_SEMANTICS_INVALID"
  | "UNKNOWN_METRIC_DEFINITION"
  | "METRIC_ID_MISMATCH"
  | "METRIC_DIGEST_MISMATCH"
  | "METRIC_VALUE_TYPE_MISMATCH"
  | "INELIGIBLE_SCORE_SOURCE"
  | "SCORE_OUTSIDE_METRIC_DOMAIN"
  | "DETERMINISTIC_RUBRIC_DIGEST_MISMATCH";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ValidationErrorCode };

export interface EventValidators {
  event(value: unknown): ValidationResult<SkillEvent>;
  metric(value: unknown): ValidationResult<SkillMetric>;
  score(value: unknown, metric: SkillMetric): ValidationResult<SkillScore>;
  rollup(value: unknown): ValidationResult<SkillRollup>;
  candidate(value: unknown): ValidationResult<EvalCandidate>;
  approval(value: unknown): ValidationResult<EvalCandidateApproval>;
}

import { sha256Digest } from "./canonical.ts";
import type { MetricLifecyclePolicy, SkillMetric } from "./types.ts";

export interface EfficiencyDelta {
  duration_ms: number;
  retries: number;
  rework_cycles: number;
  tool_calls: number;
}

export interface RecommendationEvidence {
  comparable: boolean;
  environment_changed: boolean;
  current_trials_per_arm: number;
  comparable_environments: number;
  baseline_mean_utility: number;
  current_mean_utility: number;
  pass_rate: number;
  utility_lift: number;
  efficiency_delta: EfficiencyDelta;
  skill_id: string;
  skill_digest: string;
  cohort_digest: string;
  metric_digest: string;
  skill_type: "capability" | "preference";
  previously_retired: boolean;
}

export type RecommendationKind = "regression" | "drift" | "improve" | "retire-capability" | "retain-preference" | "reactivate";
export type RecommendationReason =
  | "UTILITY_REGRESSION_EXCEEDS_TOLERANCE" | "CHANGED_ENVIRONMENT_NEEDS_TRIALS" | "PASS_RATE_BELOW_MINIMUM"
  | "CAPABILITY_BASELINE_NON_INFERIOR" | "PREFERENCE_LIFT_IS_MATERIAL" | "RETIRED_CAPABILITY_LIFT_IS_MATERIAL";

export interface LifecycleRecommendation {
  schema_version: 1;
  recommendation_id: string;
  kind: RecommendationKind;
  reason: RecommendationReason;
  skill_id: string;
  skill_digest: string;
  cohort_digest: string;
  metric_digest: string;
  evidence_digest: string;
  evidence_counts: { trials_per_arm: number; comparable_environments: number };
  policy: MetricLifecyclePolicy;
  approval_required: true;
  advisory: true;
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

function recommendation(metric: SkillMetric, evidence: RecommendationEvidence, kind: RecommendationKind, reason: RecommendationReason): LifecycleRecommendation {
  const evidenceDigest = sha256Digest(evidence);
  const record: LifecycleRecommendation = {
    schema_version: 1,
    recommendation_id: `recommendation-${sha256Digest({ kind, evidence_digest: evidenceDigest, policy: metric.lifecycle_policy }).slice(0, 24)}`,
    kind, reason, skill_id: evidence.skill_id, skill_digest: evidence.skill_digest, cohort_digest: evidence.cohort_digest,
    metric_digest: evidence.metric_digest, evidence_digest: evidenceDigest,
    evidence_counts: { trials_per_arm: evidence.current_trials_per_arm, comparable_environments: evidence.comparable_environments },
    policy: structuredClone(metric.lifecycle_policy), approval_required: true, advisory: true,
  };
  return deepFreeze(record) as LifecycleRecommendation;
}

function hasMaterialEfficiencyImprovement(delta: EfficiencyDelta, policy: MetricLifecyclePolicy): boolean {
  return delta.duration_ms < -policy.efficiency_materiality.duration_ms
    || delta.retries < -policy.efficiency_materiality.retries
    || delta.rework_cycles < -policy.efficiency_materiality.rework_cycles
    || delta.tool_calls < -policy.efficiency_materiality.tool_calls;
}

export function recommendSkillLifecycle(metric: SkillMetric, evidence: RecommendationEvidence): LifecycleRecommendation[] {
  const policy = metric.lifecycle_policy;
  if (evidence.environment_changed && evidence.current_trials_per_arm < policy.minimum_trials_per_arm) {
    return [recommendation(metric, evidence, "drift", "CHANGED_ENVIRONMENT_NEEDS_TRIALS")];
  }
  if (!evidence.comparable
    || evidence.current_trials_per_arm < policy.minimum_trials_per_arm
    || evidence.comparable_environments < 1) return [];

  if (evidence.previously_retired) {
    return evidence.skill_type === "capability" && evidence.utility_lift > policy.material_lift
      ? [recommendation(metric, evidence, "reactivate", "RETIRED_CAPABILITY_LIFT_IS_MATERIAL")]
      : [];
  }
  const decline = evidence.baseline_mean_utility - evidence.current_mean_utility;
  if (decline > policy.regression_tolerance + Number.EPSILON) {
    return [recommendation(metric, evidence, "regression", "UTILITY_REGRESSION_EXCEEDS_TOLERANCE")];
  }
  if (evidence.pass_rate < policy.minimum_pass_rate) {
    return [recommendation(metric, evidence, "improve", "PASS_RATE_BELOW_MINIMUM")];
  }
  if (evidence.skill_type === "preference") {
    return evidence.utility_lift >= policy.material_lift
      ? [recommendation(metric, evidence, "retain-preference", "PREFERENCE_LIFT_IS_MATERIAL")]
      : [];
  }
  if (evidence.comparable_environments >= policy.minimum_comparable_environments
    && evidence.utility_lift <= policy.non_inferiority_margin
    && !hasMaterialEfficiencyImprovement(evidence.efficiency_delta, policy)) {
    return [recommendation(metric, evidence, "retire-capability", "CAPABILITY_BASELINE_NON_INFERIOR")];
  }
  return [];
}

export const generateLifecycleRecommendations = recommendSkillLifecycle;

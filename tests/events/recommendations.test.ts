import assert from "node:assert/strict";
import { test } from "node:test";
import { recommendSkillLifecycle, sha256Digest, type RecommendationEvidence, type SkillMetric } from "../../packages/events/src/index.ts";

const policy = {
  minimum_trials_per_arm: 3, minimum_comparable_environments: 2, minimum_pass_rate: 0.8,
  regression_tolerance: 0.05, material_lift: 0.1, non_inferiority_margin: 0.02,
  efficiency_materiality: { duration_ms: 100, retries: 1, rework_cycles: 1, tool_calls: 2 },
};
const metric: SkillMetric = {
  schema_version: 1, metric_id: "quality", version: "1", description: "Quality", value_type: "number",
  number_range: { min: 0, max: 1 }, direction: "maximize", pass_rule: { operator: "gte", value: 0.8 },
  eligible_score_sources: ["deterministic"], eligible_verification_codes: [], lifecycle_policy: policy,
};
function evidence(overrides: Partial<RecommendationEvidence> = {}): RecommendationEvidence {
  return {
    comparable: true, environment_changed: false, current_trials_per_arm: 3, comparable_environments: 2,
    baseline_mean_utility: 0.9, current_mean_utility: 0.9, pass_rate: 0.8, utility_lift: 0.03,
    efficiency_delta: { duration_ms: 0, retries: 0, rework_cycles: 0, tool_calls: 0 },
    skill_id: "pragman:review", skill_digest: "a".repeat(64), cohort_digest: "b".repeat(64), metric_digest: sha256Digest(metric),
    skill_type: "capability", previously_retired: false, ...overrides,
  };
}

test("recommendations honor exact boundaries and stay immutable advisory records", () => {
  assert.deepEqual(recommendSkillLifecycle(metric, evidence({ current_mean_utility: 0.85 })), []);
  assert.equal(recommendSkillLifecycle(metric, evidence({ current_mean_utility: 0.849 }))[0]?.kind, "regression");
  assert.deepEqual(recommendSkillLifecycle(metric, evidence({ pass_rate: 0.8 })), []);
  assert.equal(recommendSkillLifecycle(metric, evidence({ pass_rate: 0.799, current_mean_utility: 0.9 }))[0]?.kind, "improve");
  const recommendation = recommendSkillLifecycle(metric, evidence({ current_mean_utility: 0.849 }))[0]!;
  assert.equal(recommendation.approval_required, true);
  assert.equal(Object.isFrozen(recommendation), true);
  assert.equal("apply" in recommendation, false);
  assert.deepEqual(recommendation.policy, policy);
});

test("drift is the only recommendation allowed for insufficient or incomparable evidence", () => {
  assert.deepEqual(recommendSkillLifecycle(metric, evidence({ comparable: false })), []);
  assert.equal(recommendSkillLifecycle(metric, evidence({ comparable: false, environment_changed: true, current_trials_per_arm: 2 }))[0]?.kind, "drift");
  assert.deepEqual(recommendSkillLifecycle(metric, evidence({ environment_changed: true, current_trials_per_arm: 3 })), []);
});

test("retire, retain preference, and reactivate use policy materiality and prior state", () => {
  assert.equal(recommendSkillLifecycle(metric, evidence({ utility_lift: 0.02 }))[0]?.kind, "retire-capability");
  assert.deepEqual(recommendSkillLifecycle(metric, evidence({ comparable_environments: 1, utility_lift: 0.02 })), []);
  assert.deepEqual(recommendSkillLifecycle(metric, evidence({ utility_lift: 0.02, efficiency_delta: { duration_ms: -101, retries: 0, rework_cycles: 0, tool_calls: 0 } })), []);
  assert.equal(recommendSkillLifecycle(metric, evidence({ skill_type: "preference", utility_lift: 0.1 }))[0]?.kind, "retain-preference");
  assert.equal(recommendSkillLifecycle(metric, evidence({ previously_retired: true, utility_lift: 0.101 }))[0]?.kind, "reactivate");
  assert.deepEqual(recommendSkillLifecycle(metric, evidence({ previously_retired: true, utility_lift: 0.1 })), []);
});

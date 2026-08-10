import assert from "node:assert/strict";
import { test } from "node:test";

import {
  calculateOutcomeMetrics,
  calculateRoutingMetrics,
  calculateScoreMetrics,
  metricPasses,
  normalizeMetricUtility,
  type SkillEvent,
  type SkillMetric,
  type SkillScore,
} from "../../packages/events/src/index.ts";

const digest = (character: string) => character.repeat(64);

function event(index: number, overrides: Partial<SkillEvent> = {}): SkillEvent {
  return {
    schema_version: 1,
    event_id: `0000000${index}-7f2d-7a51-a9c0-1d4cb73b10ab`,
    invocation_id: `1000000${index}-7f2d-7a51-a9c0-1d4cb73b10ab`,
    timestamp: `2026-08-10T12:0${index}:00Z`, event_type: "invoked",
    skill_id: "pragman:review", skill_version: "1.0.0", skill_digest: digest("a"), skill_type: "capability",
    host: "codex", host_version: "1", model: "gpt-5", model_version: "1", harness_version: "1",
    invocation_mode: "eval", session_id: null, route_id: null, eval_id: "eval-one", case_id: `case-${index}`,
    trial_id: `trial-${index}`, provider: "pragman:review", ablation_arm: "skill-on",
    trigger_expected: true, trigger_actual: true, provider_digest: digest("b"), eval_corpus_digest: digest("c"),
    trial_policy_digest: digest("d"), status: null, outcome_code: null, duration_ms: index * 10,
    tool_calls: index, retries: index % 2, rework_cycles: index % 3, verification_checks: 0,
    verification_passes: 0, observation_source: "eval-runner", source_aliases: [], storage_scope: "local",
    append_only: true, ...overrides,
  };
}

const policy = {
  minimum_trials_per_arm: 2, minimum_comparable_environments: 1, minimum_pass_rate: 0.8,
  regression_tolerance: 0.05, material_lift: 0.1, non_inferiority_margin: 0.02,
  efficiency_materiality: { duration_ms: 10, retries: 1, rework_cycles: 1, tool_calls: 1 },
};

function metric(overrides: Partial<SkillMetric> = {}): SkillMetric {
  return {
    schema_version: 1, metric_id: "quality", version: "1", description: "Quality", value_type: "number",
    number_range: { min: 0, max: 10 }, direction: "maximize", pass_rule: { operator: "gte", value: 7 },
    eligible_score_sources: ["deterministic"], eligible_verification_codes: ["verified-success"],
    lifecycle_policy: policy, ...overrides,
  };
}

function score(index: number, value: SkillScore["value"]): SkillScore {
  return {
    schema_version: 1, score_id: `2000000${index}-7f2d-7a51-a9c0-1d4cb73b10ab`, timestamp: "2026-08-11T00:00:00Z",
    invocation_id: event(index).invocation_id, eval_id: "eval-one", case_id: `case-${index}`, trial_id: `trial-${index}`,
    metric_id: "quality", metric_definition_digest: digest("e"), value, value_type: "number", source: "deterministic",
    grader_id: "grader", grader_version: "1", rubric_digest: digest("f"), evidence_digests: [], storage_scope: "local",
  };
}

test("routing rates expose numerators and denominators and exclude unknown expectations", () => {
  const result = calculateRoutingMetrics([
    event(1),
    event(2, { trigger_expected: true, trigger_actual: false }),
    event(3, { trigger_expected: false, trigger_actual: false }),
    event(4, { trigger_expected: false, trigger_actual: true }),
    event(5, { trigger_expected: null, trigger_actual: true }),
  ]);
  assert.deepEqual(result.activation_precision, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.deepEqual(result.activation_recall, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.deepEqual(result.no_op_accuracy, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.equal(result.excluded_unknown_expectation, 1);
});

test("outcomes use completed verifier-eligible invocations and stable distributions", () => {
  const events = [
    event(1), event(1, { event_id: "30000001-7f2d-7a51-a9c0-1d4cb73b10ab", event_type: "completed", status: "succeeded", outcome_code: "verified-success", duration_ms: 30, verification_checks: 2, verification_passes: 2 }),
    event(1, { event_id: "40000001-7f2d-7a51-a9c0-1d4cb73b10ab", event_type: "verified", status: "succeeded", outcome_code: "verified-success", duration_ms: 30, verification_checks: 2, verification_passes: 2 }),
    event(2), event(2, { event_id: "30000002-7f2d-7a51-a9c0-1d4cb73b10ab", event_type: "completed", status: "failed", outcome_code: "verified-success", duration_ms: 10, retries: 2 }),
    event(3), event(3, { event_id: "30000003-7f2d-7a51-a9c0-1d4cb73b10ab", event_type: "completed", status: "succeeded", outcome_code: "not-eligible", duration_ms: 20 }),
  ];
  const result = calculateOutcomeMetrics(events, metric());
  assert.deepEqual(result.completion, { numerator: 3, denominator: 3, rate: 1 });
  assert.deepEqual(result.verified_success, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.deepEqual(result.distributions.duration_ms.values, [10, 20, 30]);
  assert.equal(result.distributions.duration_ms.mean, 20);
  assert.deepEqual(result.status_counts, { succeeded: 2, partial: 0, failed: 1, cancelled: 0, "handoff-required": 0 });
});

test("normalizes all published metric directions without reading metric names", () => {
  assert.equal(normalizeMetricUtility(metric(), 2), 0.2);
  assert.equal(normalizeMetricUtility(metric({ direction: "minimize", pass_rule: { operator: "lte", value: 3 } }), 2), 0.8);
  assert.equal(normalizeMetricUtility(metric({ direction: "target", target: 5, pass_rule: { operator: "eq", value: 5 } }), 8), 0.4);
  assert.equal(normalizeMetricUtility(metric({ direction: "target", target_range: { min: 4, max: 6 }, pass_rule: { operator: "between", min: 4, max: 6 } }), 5), 1);
  assert.equal(normalizeMetricUtility(metric({ direction: "target", target_range: { min: 4, max: 6 }, pass_rule: { operator: "between", min: 4, max: 6 } }), 2), 0.5);
  const booleanMetric = metric({ value_type: "boolean", number_range: undefined, boolean_values: [{ value: false, utility: 0.2 }, { value: true, utility: 0.9 }], pass_rule: { operator: "eq", value: true } });
  assert.equal(normalizeMetricUtility(booleanMetric, false), 0.2);
  const categoryMetric = metric({ value_type: "category", number_range: undefined, categories: [{ id: "bad", rank: 0, passing: false, utility: 0 }, { id: "good", rank: 1, passing: true, utility: 0.75 }], pass_rule: { operator: "eq", value: "good" } });
  assert.equal(normalizeMetricUtility(categoryMetric, "good"), 0.75);
});

test("score summaries expose raw mean, utility mean, and pass-rule reliability", () => {
  const scores = [score(1, 9), score(2, 7), score(3, 2)];
  const result = calculateScoreMetrics(scores, metric());
  assert.deepEqual(result.raw, { count: 3, sum: 18, mean: 6, values: [2, 7, 9] });
  assert.deepEqual(result.reliability, { numerator: 2, denominator: 3, rate: 2 / 3 });
  assert.equal(result.utility.mean, 0.6);
  assert.equal(metricPasses(metric({ metric_id: "anything" }), 7), true);
});

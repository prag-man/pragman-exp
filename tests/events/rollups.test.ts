import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateWeeklyRollups,
  buildDailyRollups,
  createEventValidators,
  rebuildRollups,
  sealRollup,
  verifyRollup,
  type SkillEvent,
  type SkillMetric,
  type SkillScore,
} from "../../packages/events/src/index.ts";

const digest = (character: string) => character.repeat(64);
const metric: SkillMetric = {
  schema_version: 1, metric_id: "quality", version: "1", description: "Quality", value_type: "number",
  number_range: { min: 0, max: 10 }, direction: "maximize", pass_rule: { operator: "gte", value: 7 },
  eligible_score_sources: ["deterministic"], eligible_verification_codes: ["verified-success"], lifecycle_policy: {
    minimum_trials_per_arm: 2, minimum_comparable_environments: 1, minimum_pass_rate: 0.8, regression_tolerance: 0.05,
    material_lift: 0.1, non_inferiority_margin: 0.02,
    efficiency_materiality: { duration_ms: 10, retries: 1, rework_cycles: 1, tool_calls: 1 },
  },
};

function event(index: number, date = "2026-08-10", overrides: Partial<SkillEvent> = {}): SkillEvent {
  return {
    schema_version: 1, event_id: `0000000${index}-7f2d-7a51-a9c0-1d4cb73b10ab`, invocation_id: "10000001-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: `${date}T12:0${index}:00Z`, event_type: index === 1 ? "invoked" : "completed", skill_id: "pragman:review",
    skill_version: "1", skill_digest: digest("a"), skill_type: "capability", host: "codex", host_version: "1",
    model: "gpt-5", model_version: "1", harness_version: "1", invocation_mode: "eval", session_id: "secret-session",
    route_id: "secret-route", eval_id: "eval-one", case_id: "case-one", trial_id: "trial-one", provider: "pragman:review",
    ablation_arm: "skill-on", trigger_expected: true, trigger_actual: true, provider_digest: digest("b"),
    eval_corpus_digest: digest("c"), trial_policy_digest: digest("d"), status: index === 1 ? null : "succeeded",
    outcome_code: index === 1 ? null : "verified-success", duration_ms: index === 1 ? 0 : 100, tool_calls: index,
    retries: 0, rework_cycles: 0, verification_checks: 0, verification_passes: 0, observation_source: "eval-runner",
    source_aliases: ["private-alias"], storage_scope: "local", append_only: true, ...overrides,
  };
}

function score(index: number, value: number, overrides: Partial<SkillScore> = {}): SkillScore {
  return {
    schema_version: 1, score_id: `2000000${index}-7f2d-7a51-a9c0-1d4cb73b10ab`, timestamp: "2026-08-10T13:00:00Z",
    invocation_id: event(1).invocation_id, eval_id: "eval-one", case_id: "case-one", trial_id: "trial-one",
    metric_id: "quality", metric_definition_digest: digest("e"), value, value_type: "number", source: "deterministic",
    grader_id: "grader", grader_version: "1", rubric_digest: digest("f"), evidence_digests: [], storage_scope: "local", ...overrides,
  };
}

test("daily rollups use bounded dimensions, latest corrections, and canonical source evidence", () => {
  const original = score(1, 2);
  const correction = score(2, 8, { timestamp: "2026-08-11T13:00:00Z", supersedes_score_id: original.score_id });
  const rollups = buildDailyRollups([event(1), event(2)], [original, correction], new Map([[digest("e"), metric]]), "2026-08-10");
  assert.equal(rollups.length, 1);
  const rollup = rollups[0]!;
  assert.equal("invocation_id" in rollup.dimensions, false);
  assert.equal("session_id" in rollup.dimensions, false);
  assert.equal("route_id" in rollup.dimensions, false);
  assert.equal("source_aliases" in rollup.dimensions, false);
  assert.equal(rollup.source_record_count, 4);
  assert.match(rollup.source_record_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(rollup.score_aggregate, { count: 1, sum: 8, utility_sum: 0.8, pass_count: 1, correction_count: 1 });
  assert.equal(createEventValidators([metric]).rollup(rollup).ok, true);
  assert.equal(verifyRollup(rollup, [event(1), event(2)], [original, correction], new Map([[digest("e"), metric]])).valid, true);
});

test("daily to weekly aggregation is deterministic and sealing changes only sealed state and id", () => {
  const first = buildDailyRollups([event(1), event(2)], [], new Map(), "2026-08-10")[0]!;
  const next = buildDailyRollups([event(1, "2026-08-11"), event(2, "2026-08-11")], [], new Map(), "2026-08-11")[0]!;
  const weekly = aggregateWeeklyRollups([next, first], "2026-08-10");
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0]!.period, "weekly");
  assert.equal(weekly[0]!.counts.invoked, 2);
  const sealed = sealRollup(first);
  assert.equal(sealed.sealed, true);
  assert.equal(first.sealed, false);
});

test("rebuild replaces recent derived days and preserves sealed history", () => {
  const oldSealed = sealRollup(buildDailyRollups([event(1), event(2)], [], new Map(), "2026-08-10")[0]!);
  const recent = buildDailyRollups([event(1, "2026-08-11"), event(2, "2026-08-11")], [], new Map(), "2026-08-11")[0]!;
  const rebuilt = rebuildRollups(
    [oldSealed, recent],
    [event(1), event(2), event(1, "2026-08-11"), event(2, "2026-08-11", { duration_ms: 200 })],
    [], new Map(), "2026-08-10", "2026-08-11",
  );
  assert.equal(rebuilt.daily.filter((rollup) => rollup.period_start.startsWith("2026-08-10")).length, 1);
  assert.equal(rebuilt.daily.some((rollup) => rollup.rollup_id === oldSealed.rollup_id && rollup.sealed), true);
  assert.equal(rebuilt.daily.find((rollup) => rollup.period_start.startsWith("2026-08-11"))?.sums.duration_ms, 200);
});

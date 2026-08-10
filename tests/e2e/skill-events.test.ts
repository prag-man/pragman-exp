import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as eventsApi from "../../packages/events/src/index.ts";
import {
  aggregateWeeklyRollups,
  appendDurable,
  buildDailyRollups,
  createEvalCandidate,
  createEvalCandidateDecision,
  createEventValidators,
  createLifecycleIndex,
  readPartition,
  recommendSkillLifecycle,
  sealRollup,
  sha256Digest,
  type SkillEvent,
  type SkillMetric,
  type SkillScore,
} from "../../packages/events/src/index.ts";

const runner = new URL("../../scripts/run-evals.mjs", import.meta.url).pathname;
const fixtures = new URL("../../evals/fixtures/skill-events/", import.meta.url).pathname;
const digest = (character: string) => character.repeat(64);

const metric: SkillMetric = {
  schema_version: 1,
  metric_id: "task-success",
  version: "1.0.0",
  description: "Deterministic task success.",
  value_type: "boolean",
  boolean_values: [{ value: false, utility: 0 }, { value: true, utility: 1 }],
  direction: "maximize",
  pass_rule: { operator: "eq", value: true },
  eligible_score_sources: ["deterministic"],
  eligible_verification_codes: ["verified-success"],
  lifecycle_policy: {
    minimum_trials_per_arm: 3,
    minimum_comparable_environments: 1,
    minimum_pass_rate: 0.8,
    regression_tolerance: 0.05,
    material_lift: 0.1,
    non_inferiority_margin: 0.02,
    efficiency_materiality: { duration_ms: 100, retries: 1, rework_cycles: 1, tool_calls: 2 },
  },
};
const metricDigest = sha256Digest(metric);

function event(
  eventType: SkillEvent["event_type"],
  eventId: string,
  timestamp: string,
  overrides: Partial<SkillEvent> = {},
): SkillEvent {
  return {
    schema_version: 1,
    event_id: eventId,
    invocation_id: "01905b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp,
    event_type: eventType,
    skill_id: "pragman:review",
    skill_version: "1.2.3",
    skill_digest: digest("c"),
    skill_type: "capability",
    host: "codex",
    host_version: "1.0.0",
    model: "gpt-5",
    model_version: "2026-08-01",
    harness_version: "1.0.0",
    invocation_mode: "router",
    session_id: null,
    route_id: null,
    eval_id: null,
    case_id: null,
    trial_id: null,
    provider: "pragman:builtin-review",
    ablation_arm: "production",
    trigger_expected: true,
    trigger_actual: eventType === "eligible" ? null : true,
    provider_digest: digest("d"),
    eval_corpus_digest: null,
    trial_policy_digest: null,
    status: null,
    outcome_code: null,
    duration_ms: 0,
    tool_calls: 0,
    retries: 0,
    rework_cycles: 0,
    verification_checks: 0,
    verification_passes: 0,
    observation_source: "router",
    source_aliases: ["router-observer"],
    storage_scope: "local",
    append_only: true,
    ...overrides,
  };
}

test("content-free route evidence reaches rollups, paired eval, and an advisory improve recommendation", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pragman-skill-events-e2e-"));
  const records = [
    event("eligible", "018f5b8c-7f2d-7a51-a9c0-1d4cb73b10ab", "2026-08-10T12:00:00Z"),
    event("invoked", "01905b8c-7f2d-7a51-a9c0-1d4cb73b10ab", "2026-08-10T12:00:01Z"),
    event("completed", "01905c8c-7f2d-7a51-a9c0-1d4cb73b10ab", "2026-08-10T12:01:00Z", {
      status: "succeeded", duration_ms: 59_000, tool_calls: 2,
    }),
    event("verified", "01905d8c-7f2d-7a51-a9c0-1d4cb73b10ab", "2026-08-10T12:05:00Z", {
      status: "succeeded", outcome_code: "verified-success", duration_ms: 59_000,
      tool_calls: 2, verification_checks: 1, verification_passes: 1,
    }),
  ];
  const delayedScore: SkillScore = {
    schema_version: 1,
    score_id: "01915b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-11T12:00:00Z",
    invocation_id: records[0]!.invocation_id,
    metric_id: metric.metric_id,
    metric_definition_digest: metricDigest,
    value: true,
    value_type: "boolean",
    source: "deterministic",
    grader_id: "deterministic-task-check",
    grader_version: "1.0.0",
    rubric_digest: metricDigest,
    evidence_digests: [digest("8")],
    storage_scope: "local",
  };

  const validators = createEventValidators([metric]);
  const lifecycle = createLifecycleIndex();
  for (const record of records) {
    assert.equal(validators.event(record).ok, true);
    assert.deepEqual(lifecycle.addEvent(record), { ok: true, status: "accepted" });
    assert.equal((await appendDurable(stateRoot, "skill-events", record)).status, "appended");
  }
  assert.equal(validators.score(delayedScore, metric).ok, true);
  assert.deepEqual(lifecycle.addScore(delayedScore), { ok: true, status: "accepted" });
  assert.equal((await appendDurable(stateRoot, "scores", delayedScore)).status, "appended");
  assert.equal(lifecycle.getInvocation(records[0]!.invocation_id)?.state, "verified");

  const persistedEvents = await readPartition<SkillEvent>(stateRoot, "skill-events", "2026-08-10");
  const persistedScores = await readPartition<SkillScore>(stateRoot, "scores", "2026-08-11");
  const persistedText = JSON.stringify({ persistedEvents, persistedScores });
  for (const forbidden of ["prompt", "output", "transcript", "tool_args", "secret"]) {
    assert.equal(persistedText.toLowerCase().includes(forbidden), false, forbidden);
  }

  const daily = buildDailyRollups(records, [delayedScore], new Map([[metricDigest, metric]]), "2026-08-10");
  assert.equal(daily.length, 1);
  assert.equal(daily[0]!.counts.eligible, 1);
  assert.equal(daily[0]!.counts.verified, 1);
  assert.equal(daily[0]!.score_aggregate.pass_count, 1);
  const weekly = aggregateWeeklyRollups([sealRollup(daily[0]!)], "2026-08-10");
  assert.equal(weekly[0]!.counts.verified, 1);
  assert.equal(weekly[0]!.source_record_count, 5);

  const evidencePath = join(stateRoot, "paired-evidence.json");
  const run = spawnSync(process.execPath, [
    runner,
    "--mode",
    "skill-eval",
    join(fixtures, "baseline.json"),
    "--observed",
    join(fixtures, "forward.json"),
    "--output",
    evidencePath,
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const paired = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(paired.status, "COMPARABLE");
  assert.equal(paired.pair_count, 6);
  assert.equal(paired.significance, null);
  assert.equal(paired.significance_reason, "MINIMUM_20_PAIRS_REQUIRED");
  for (const field of [
    "eval_corpus_digest", "trial_policy_digest", "skill_digest", "provider_digest", "environment_digest",
    "metric_definition_digest", "grader_digest", "rubric_digest", "host_version", "model_version", "harness_version",
  ]) assert.match(paired.comparison_identity[field], field.endsWith("digest") ? /^[a-f0-9]{64}$/ : /.+/);

  const recommendation = recommendSkillLifecycle(metric, {
    comparable: true,
    environment_changed: false,
    current_trials_per_arm: 3,
    comparable_environments: 1,
    baseline_mean_utility: 0.5,
    current_mean_utility: 0.5,
    pass_rate: paired.skill_on_pass_rate,
    utility_lift: paired.utility_lift,
    efficiency_delta: paired.efficiency_delta,
    skill_id: paired.comparison_identity.skill_id,
    skill_digest: paired.comparison_identity.skill_digest,
    cohort_digest: sha256Digest(paired.comparison_identity),
    metric_digest: paired.comparison_identity.metric_definition_digest,
    skill_type: "capability",
    previously_retired: false,
  })[0]!;
  assert.equal(recommendation.kind, "improve");
  assert.equal(recommendation.advisory, true);
  assert.equal(recommendation.approval_required, true);
  assert.equal("apply" in recommendation, false);
  assert.equal(Object.keys(eventsApi).some((name) => /apply.*recommendation/i.test(name)), false);

  const candidate = createEvalCandidate({
    candidate_id: "01925b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-11T12:06:00Z",
    skill_id: records[0]!.skill_id,
    skill_digest: records[0]!.skill_digest,
    corpus_id: "review-failures",
    source_event_digests: [sha256Digest(records[3])],
    recommendation_digest: sha256Digest(recommendation),
    failure_codes: ["verification-gap"],
    redacted_artifact_alias: "artifact-one",
    redacted_artifact_digest: digest("9"),
  });
  const approval = createEvalCandidateDecision(candidate, {
    approval_id: "01935b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-11T12:07:00Z",
    decision: "approved",
    reviewed_redacted_artifact_digest: candidate.redacted_artifact_digest,
  });
  assert.deepEqual(lifecycle.addCandidate(candidate), { ok: true, status: "accepted" });
  assert.deepEqual(lifecycle.addApproval(approval), { ok: true, status: "accepted" });
  assert.equal((await appendDurable(stateRoot, "eval-candidates", candidate)).status, "appended");
  assert.equal((await appendDurable(stateRoot, "candidate-approvals", approval)).status, "appended");
  const futureUnfckEligibility = { candidate_id: candidate.candidate_id, approval_id: approval.approval_id };
  assert.deepEqual(Object.keys(futureUnfckEligibility).sort(), ["approval_id", "candidate_id"]);
  assert.deepEqual(
    (await readPartition(stateRoot, "eval-candidates", "2026-08-11")).records,
    [candidate],
  );
  assert.deepEqual(
    (await readPartition(stateRoot, "candidate-approvals", "2026-08-11")).records,
    [approval],
  );
  assert.equal(Object.keys(eventsApi).some((name) => /corpus|patch|mutate/i.test(name)), false);
});

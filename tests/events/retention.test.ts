import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRetentionPlan,
  createPurgePlan,
  createRetentionPlan,
  sha256Digest,
  type RetentionState,
  type SkillEvent,
  type SkillScore,
} from "../../packages/events/src/index.ts";

const digest = (character: string) => character.repeat(64);
const invoked = (invocation_id: string, timestamp: string): SkillEvent => ({
  schema_version: 1, event_id: crypto.randomUUID(), invocation_id, timestamp, event_type: "invoked",
  skill_id: "pragman:review", skill_version: "1.0.0", skill_digest: digest("a"), skill_type: "capability",
  host: "codex", host_version: "1", model: "gpt", model_version: "1", harness_version: "1",
  invocation_mode: "host", session_id: "private-session", route_id: "private-route", eval_id: null,
  case_id: null, trial_id: null, provider: null, ablation_arm: "production", trigger_expected: null,
  trigger_actual: true, provider_digest: null, eval_corpus_digest: null, trial_policy_digest: null,
  status: null, outcome_code: null, duration_ms: 0, tool_calls: 0, retries: 0, rework_cycles: 0,
  verification_checks: 0, verification_passes: 0, observation_source: "host-adapter",
  source_aliases: ["private-source"], storage_scope: "local", append_only: true,
});

const emptyState = (): RetentionState => ({ events: [], scores: [], candidates: [], approvals: [], daily_rollups: [], weekly_rollups: [], quarantine: [] });

test("automatic retention expires complete invocation and score chains from invocation time", () => {
  const old = invoked("old", "2026-01-01T00:00:00Z");
  const recent = invoked("recent", "2026-08-01T00:00:00Z");
  const score: SkillScore = {
    schema_version: 1, score_id: crypto.randomUUID(), timestamp: "2026-07-01T00:00:00Z", invocation_id: "old",
    metric_id: "task-success", metric_definition_digest: digest("b"), value: true, value_type: "boolean",
    source: "deterministic", grader_id: "grader", grader_version: "1", rubric_digest: digest("b"),
    evidence_digests: [digest("c")], storage_scope: "local",
  };
  const state = { ...emptyState(), events: [old, recent], scores: [score] };
  const plan = createRetentionPlan(state, "2026-08-10T00:00:00Z");
  assert.deepEqual(plan.remove.event_ids, [old.event_id]);
  assert.deepEqual(plan.remove.score_ids, [score.score_id]);
  assert.equal(plan.compact_days.includes("2026-01-01"), true);
});

test("candidate decisions, quarantine, and daily rollups expire together while weekly is retained", () => {
  const state = emptyState();
  state.candidates.push({ schema_version: 1, candidate_id: "01925b8c-7f2d-7a51-a9c0-1d4cb73b10ab", timestamp: "2026-01-01T00:00:00Z", skill_id: "pragman:review", skill_digest: digest("a"), corpus_id: "failures", source_event_digests: [digest("b")], failure_codes: ["failed"], redacted_artifact_alias: "local", redacted_artifact_digest: digest("c"), approval_status: "pending", storage_scope: "local", append_only: true });
  state.approvals.push({ schema_version: 1, approval_id: "01935b8c-7f2d-7a51-a9c0-1d4cb73b10ab", timestamp: "2026-08-01T00:00:00Z", candidate_id: state.candidates[0]!.candidate_id, candidate_digest: sha256Digest(state.candidates[0]), decision: "approved", approval_source: "user", reviewed_redacted_artifact_digest: digest("c"), storage_scope: "local", append_only: true });
  state.quarantine.push({ quarantine_id: "q-old", timestamp: "2026-06-01T00:00:00Z" });
  state.daily_rollups.push({ rollup_id: "daily-old", period: "daily", period_start: "2024-01-01T00:00:00Z" } as never);
  state.weekly_rollups.push({ rollup_id: "weekly-old", period: "weekly", period_start: "2020-01-01T00:00:00Z" } as never);
  const plan = createRetentionPlan(state, "2026-08-10T00:00:00Z");
  assert.deepEqual(plan.remove.candidate_ids, [state.candidates[0]!.candidate_id]);
  assert.deepEqual(plan.remove.approval_ids, [state.approvals[0]!.approval_id]);
  assert.deepEqual(plan.remove.quarantine_ids, ["q-old"]);
  assert.deepEqual(plan.remove.daily_rollup_ids, ["daily-old"]);
  assert.deepEqual(plan.remove.weekly_rollup_ids, []);
});

test("automatic apply retains raw history and reports debt when compact verification fails", async () => {
  const old = invoked("old", "2026-01-01T00:00:00Z");
  const state = { ...emptyState(), events: [old] };
  const plan = createRetentionPlan(state, "2026-08-10T00:00:00Z");
  const failed = await applyRetentionPlan(plan, state, {
    now: () => new Date("2026-08-10T00:01:00Z"),
    withMutationLock: async (operation) => operation(),
    sealAndVerifyDaily: async () => false,
    recomputeWeekly: async () => true,
  });
  assert.equal(failed.applied, false);
  assert.equal(failed.reason, "RETENTION_DEBT");
  assert.deepEqual(failed.state.events, [old]);
});

test("explicit purge plans bind class/range/current state and disclose lost rebuildability", () => {
  const state = { ...emptyState(), events: [invoked("old", "2026-01-01T00:00:00Z")] };
  const plan = createPurgePlan(state, { classes: ["raw"], from: "2026-01-01", through: "2026-01-31" }, "2026-08-10T00:00:00Z");
  assert.equal(plan.kind, "explicit-purge");
  assert.equal(plan.history_rebuildable, false);
  assert.equal(plan.current_state_digest, sha256Digest(state));
  assert.equal(plan.plan_digest.length, 64);
});

test("apply rejects a tampered plan digest and compacts in seal then weekly order", async () => {
  const old = invoked("old", "2026-01-01T00:00:00Z");
  const state = { ...emptyState(), events: [old] };
  const plan = createRetentionPlan(state, "2026-08-10T00:00:00Z");
  const dependencies = {
    now: () => new Date("2026-08-10T00:01:00Z"),
    withMutationLock: async <T>(operation: () => Promise<T>) => operation(),
    sealAndVerifyDaily: async () => true,
    recomputeWeekly: async () => true,
  };
  assert.equal((await applyRetentionPlan({ ...plan, compact_days: [] }, state, dependencies)).reason, "PLAN_DIGEST_INVALID");
  const order: string[] = [];
  const applied = await applyRetentionPlan(plan, state, {
    ...dependencies,
    sealAndVerifyDaily: async (date) => { order.push(`seal:${date}`); return true; },
    recomputeWeekly: async (date) => { order.push(`week:${date}`); return true; },
  });
  assert.equal(applied.applied, true);
  assert.deepEqual(order, ["seal:2026-01-01", "week:2025-12-29"]);
});

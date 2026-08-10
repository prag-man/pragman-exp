import assert from "node:assert/strict";
import test from "node:test";

import { applyExportPlan, createExportPlan, type RetentionState, type SkillEvent } from "../../packages/events/src/index.ts";

const digest = (character: string) => character.repeat(64);
const event: SkillEvent = {
  schema_version: 1, event_id: "018f5b8c-7f2d-7a51-a9c0-1d4cb73b10ab", invocation_id: "secret-invocation", timestamp: "2026-08-10T00:00:00Z", event_type: "invoked",
  skill_id: "pragman:review", skill_version: "1", skill_digest: digest("a"), skill_type: "capability", host: "codex", host_version: "1", model: "gpt", model_version: "1", harness_version: "1", invocation_mode: "host", session_id: "secret-session", route_id: "secret-route", eval_id: null, case_id: null, trial_id: null, provider: null, ablation_arm: "production", trigger_expected: null, trigger_actual: true, provider_digest: null, eval_corpus_digest: null, trial_policy_digest: null, status: null, outcome_code: null, duration_ms: 0, tool_calls: 0, retries: 0, rework_cycles: 0, verification_checks: 0, verification_passes: 0, observation_source: "host-adapter", source_aliases: ["secret-source"], storage_scope: "local", append_only: true,
};
const state: RetentionState = { events: [event], scores: [], candidates: [{ redacted_artifact_alias: "never-export" } as never], approvals: [{ decision: "approved" } as never], daily_rollups: [{ rollup_id: "daily" } as never], weekly_rollups: [], quarantine: [] };

test("export is aggregate-first and excludes candidate and approval records", () => {
  const plan = createExportPlan(state, {}, "2026-08-10T00:00:00Z");
  assert.equal(plan.mode, "aggregate");
  const result = applyExportPlan(plan, state, "2026-08-10T00:01:00Z");
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("never-export"), false);
  assert.equal(serialized.includes("approved"), false);
});

test("raw export requires a second explicit choice and emits export-local cohort IDs", () => {
  const needsApproval = createExportPlan(state, { mode: "raw" }, "2026-08-10T00:00:00Z");
  assert.equal(needsApproval.status, "NEEDS_APPROVAL");
  const plan = createExportPlan(state, { mode: "raw", confirm_content_free_raw: true }, "2026-08-10T00:00:00Z");
  assert.equal(plan.status, "READY");
  if (plan.status !== "READY") return;
  const result = applyExportPlan(plan, state, "2026-08-10T00:01:00Z");
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /cohort-000001/);
  for (const forbidden of ["secret-invocation", "secret-session", "secret-route", "secret-source", "event_id", "source_aliases"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("export apply rejects an expired or stale preview", () => {
  const plan = createExportPlan(state, {}, "2026-08-10T00:00:00Z");
  assert.deepEqual(applyExportPlan(plan, { ...state, events: [] }, "2026-08-10T00:01:00Z"), { ok: false, reason: "STALE_STATE" });
  assert.deepEqual(applyExportPlan(plan, state, "2026-08-10T00:20:00Z"), { ok: false, reason: "PLAN_EXPIRED" });
});

test("raw export omits score evidence and correction identifiers", () => {
  const withScore: RetentionState = {
    ...state,
    scores: [{ schema_version: 1, score_id: "score-private", timestamp: event.timestamp, invocation_id: event.invocation_id,
      metric_id: "task-success", metric_definition_digest: digest("b"), value: true, value_type: "boolean", source: "deterministic",
      grader_id: "grader", grader_version: "1", rubric_digest: digest("c"), evidence_digests: [digest("d")], supersedes_score_id: "prior-private", storage_scope: "local" }],
  };
  const plan = createExportPlan(withScore, { mode: "raw", confirm_content_free_raw: true }, "2026-08-10T00:00:00Z");
  assert.equal(plan.status, "READY");
  if (plan.status !== "READY") return;
  const serialized = JSON.stringify(applyExportPlan(plan, withScore, "2026-08-10T00:01:00Z"));
  for (const forbidden of ["score-private", "prior-private", digest("d"), "evidence_digests"]) assert.equal(serialized.includes(forbidden), false);
});

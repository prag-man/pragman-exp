import assert from "node:assert/strict";
import test from "node:test";

import {
  createLifecycleIndex,
  sha256Digest,
  type EvalCandidate,
  type EvalCandidateApproval,
  type SkillEvent,
  type SkillScore,
} from "../../packages/events/src/index.ts";

const digest = (character: string) => character.repeat(64);

function event(overrides: Partial<SkillEvent> = {}): SkillEvent {
  return {
    schema_version: 1,
    event_id: "018f5b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    invocation_id: "01905b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:00:00Z",
    event_type: "invoked",
    skill_id: "pragman:review",
    skill_version: "1.2.3",
    skill_digest: digest("a"),
    skill_type: "capability",
    host: "codex",
    host_version: "1.2.0",
    model: "gpt-5",
    model_version: "2026-08-01",
    harness_version: "1.0.0",
    invocation_mode: "host",
    session_id: null,
    route_id: null,
    eval_id: null,
    case_id: null,
    trial_id: null,
    provider: "pragman:builtin-review",
    ablation_arm: "production",
    trigger_expected: null,
    trigger_actual: true,
    provider_digest: digest("b"),
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
    observation_source: "host-adapter",
    source_aliases: ["host-observation"],
    storage_scope: "local",
    append_only: true,
    ...overrides,
  };
}

function terminal(
  eventType: "completed" | "cancelled" = "completed",
  overrides: Partial<SkillEvent> = {},
): SkillEvent {
  return event({
    event_id: eventType === "completed"
      ? "01905c8c-7f2d-7a51-a9c0-1d4cb73b10ab"
      : "01905d8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:01:00Z",
    event_type: eventType,
    status: eventType === "completed" ? "succeeded" : "cancelled",
    duration_ms: 60_000,
    tool_calls: 2,
    ...overrides,
  });
}

function verified(overrides: Partial<SkillEvent> = {}): SkillEvent {
  return event({
    event_id: "01905e8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:05:00Z",
    event_type: "verified",
    status: "succeeded",
    outcome_code: "verified-success",
    duration_ms: 60_000,
    tool_calls: 2,
    verification_checks: 2,
    verification_passes: 2,
    ...overrides,
  });
}

function score(overrides: Partial<SkillScore> = {}): SkillScore {
  return {
    schema_version: 1,
    score_id: "01915b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-11T12:00:00Z",
    invocation_id: event().invocation_id,
    eval_id: "review-v1",
    case_id: "case-one",
    trial_id: "trial-one",
    metric_id: "task-success",
    metric_definition_digest: digest("c"),
    value: true,
    value_type: "boolean",
    source: "deterministic",
    grader_id: "task-success-grader",
    grader_version: "1.0.0",
    rubric_digest: digest("c"),
    evidence_digests: [digest("d")],
    storage_scope: "local",
    ...overrides,
  };
}

function candidate(overrides: Partial<EvalCandidate> = {}): EvalCandidate {
  return {
    schema_version: 1,
    candidate_id: "01925b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:06:00Z",
    skill_id: "pragman:review",
    skill_digest: digest("a"),
    corpus_id: "review-failures",
    source_event_digests: [digest("e")],
    failure_codes: ["verification-failed"],
    redacted_artifact_alias: "artifact-one",
    redacted_artifact_digest: digest("f"),
    approval_status: "pending",
    storage_scope: "local",
    append_only: true,
    ...overrides,
  };
}

function approval(sourceCandidate: EvalCandidate, overrides: Partial<EvalCandidateApproval> = {}): EvalCandidateApproval {
  return {
    schema_version: 1,
    approval_id: "01935b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:07:00Z",
    candidate_id: sourceCandidate.candidate_id,
    candidate_digest: sha256Digest(sourceCandidate),
    decision: "approved",
    approval_source: "user",
    reviewed_redacted_artifact_digest: sourceCandidate.redacted_artifact_digest,
    storage_scope: "local",
    append_only: true,
    ...overrides,
  };
}

test("accepts invoked to completed or cancelled to delayed verified lifecycles", () => {
  for (const terminalType of ["completed", "cancelled"] as const) {
    const index = createLifecycleIndex();
    assert.deepEqual(index.addEvent(event()), { ok: true, status: "accepted" });
    assert.deepEqual(index.addEvent(terminal(terminalType)), { ok: true, status: "accepted" });
    assert.deepEqual(index.addEvent(verified({ observation_source: "user-report" })), {
      ok: true,
      status: "accepted",
    });
    assert.deepEqual(index.getInvocation(event().invocation_id), {
      invocation_id: event().invocation_id,
      state: "verified",
      terminal_event_type: terminalType,
      verified: true,
      verification_outcome: "verified-success",
      incomplete: false,
      retention_anchor: event().timestamp,
    });
  }
});

test("reports invoked-only lifecycles as incomplete and never synthesizes success", () => {
  const index = createLifecycleIndex();
  index.addEvent(event());
  assert.deepEqual(index.getInvocation(event().invocation_id), {
    invocation_id: event().invocation_id,
    state: "invoked",
    terminal_event_type: null,
    verified: false,
    verification_outcome: null,
    incomplete: true,
    retention_anchor: event().timestamp,
  });
  assert.deepEqual(index.incompleteInvocationIds(), [event().invocation_id]);

  index.addEvent(terminal("completed", { status: "succeeded" }));
  assert.equal(index.getInvocation(event().invocation_id)?.verified, false);
  assert.equal(index.getInvocation(event().invocation_id)?.verification_outcome, null);
  assert.deepEqual(index.incompleteInvocationIds(), []);
});

test("enforces one terminal event, terminal-before-verification, and stable invocation identity", () => {
  const index = createLifecycleIndex();
  index.addEvent(event());
  assert.deepEqual(index.addEvent(verified()), { ok: false, reason: "VERIFICATION_BEFORE_TERMINAL" });
  assert.deepEqual(index.addEvent(terminal()), { ok: true, status: "accepted" });
  assert.deepEqual(index.addEvent(terminal("cancelled")), { ok: false, reason: "TERMINAL_EVENT_EXISTS" });

  const separate = createLifecycleIndex();
  separate.addEvent(event());
  assert.deepEqual(separate.addEvent(terminal("completed", { skill_digest: digest("9") })), {
    ok: false,
    reason: "EVENT_IDENTITY_MISMATCH",
  });
});

test("requires terminal and verification events to advance lifecycle time", () => {
  const terminalIndex = createLifecycleIndex();
  terminalIndex.addEvent(event());
  assert.deepEqual(terminalIndex.addEvent(terminal("completed", { timestamp: event().timestamp })), {
    ok: false,
    reason: "EVENT_TIMESTAMP_NOT_LATER",
  });

  const verificationIndex = createLifecycleIndex();
  verificationIndex.addEvent(event());
  const completed = terminal();
  verificationIndex.addEvent(completed);
  assert.deepEqual(verificationIndex.addEvent(verified({ timestamp: completed.timestamp })), {
    ok: false,
    reason: "EVENT_TIMESTAMP_NOT_LATER",
  });
});

test("treats an exact event duplicate as idempotent and a divergent event ID as a collision", () => {
  const index = createLifecycleIndex();
  const invoked = event();
  assert.deepEqual(index.addEvent(invoked), { ok: true, status: "accepted" });
  assert.deepEqual(index.addEvent(structuredClone(invoked)), { ok: true, status: "duplicate" });
  assert.deepEqual(index.addEvent({ ...invoked, skill_version: "2.0.0" }), {
    ok: false,
    reason: "EVENT_ID_COLLISION",
  });
});

test("rejects a score for an unknown invocation", () => {
  const index = createLifecycleIndex();
  assert.deepEqual(index.addScore(score()), { ok: false, reason: "UNKNOWN_SCORE_INVOCATION" });
});

test("accepts one linear correction and retains the invocation timestamp as its retention anchor", () => {
  const index = createLifecycleIndex();
  const invoked = event();
  const original = score();
  const correction = score({
    score_id: "01925c8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-09-20T12:00:00Z",
    value: false,
    evidence_digests: [digest("e")],
    supersedes_score_id: original.score_id,
  });
  index.addEvent(invoked);

  assert.deepEqual(index.addScore(original), { ok: true, status: "accepted" });
  assert.deepEqual(index.addScore(correction), { ok: true, status: "accepted" });
  assert.deepEqual(index.scoreChain(original.score_id).map((record) => record.score_id), [
    original.score_id,
    correction.score_id,
  ]);
  assert.equal(index.latestScore(original.score_id)?.score_id, correction.score_id);
  assert.equal(index.scoreRetentionAnchor(correction.score_id), invoked.timestamp);
});

test("rejects missing predecessors, self-cycles, non-earlier predecessors, and forks", () => {
  const index = createLifecycleIndex();
  index.addEvent(event());
  const original = score();
  assert.deepEqual(index.addScore(score({
    score_id: "01925c8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    supersedes_score_id: "01995b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
  })), { ok: false, reason: "MISSING_SCORE_PREDECESSOR" });
  assert.deepEqual(index.addScore(score({ supersedes_score_id: score().score_id })), {
    ok: false,
    reason: "SCORE_CYCLE",
  });

  index.addScore(original);
  assert.deepEqual(index.addScore(score({
    score_id: "01925c8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: original.timestamp,
    supersedes_score_id: original.score_id,
  })), { ok: false, reason: "SCORE_PREDECESSOR_NOT_EARLIER" });

  const firstCorrection = score({
    score_id: "01925d8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-12T12:00:00Z",
    supersedes_score_id: original.score_id,
  });
  index.addScore(firstCorrection);
  assert.deepEqual(index.addScore(score({
    score_id: "01925e8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-13T12:00:00Z",
    supersedes_score_id: original.score_id,
  })), { ok: false, reason: "SCORE_FORK" });
});

test("requires every correction identity field to match its predecessor", () => {
  const alternateInvocation = event({
    event_id: "028f5b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    invocation_id: "02905b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
  });
  const changes: Partial<SkillScore>[] = [
    { invocation_id: alternateInvocation.invocation_id },
    { metric_id: "other-metric" },
    { metric_definition_digest: digest("e") },
    { value_type: "category", value: "passed" },
    { source: "llm-judge" },
    { grader_id: "other-grader" },
    { grader_version: "2.0.0" },
    { rubric_digest: digest("f") },
  ];

  for (const [indexNumber, change] of changes.entries()) {
    const index = createLifecycleIndex();
    index.addEvent(event());
    index.addEvent(alternateInvocation);
    const predecessor = score();
    index.addScore(predecessor);
    const correction = score({
      score_id: `${(indexNumber + 10).toString(16).padStart(8, "0")}-7f2d-7a51-a9c0-1d4cb73b10ab`,
      timestamp: "2026-08-12T12:00:00Z",
      supersedes_score_id: predecessor.score_id,
      ...change,
    });
    assert.deepEqual(index.addScore(correction), { ok: false, reason: "SCORE_IDENTITY_MISMATCH" });
  }
});

test("treats exact score duplicates as idempotent and divergent score IDs as collisions", () => {
  const index = createLifecycleIndex();
  index.addEvent(event());
  const original = score();
  assert.deepEqual(index.addScore(original), { ok: true, status: "accepted" });
  assert.deepEqual(index.addScore(structuredClone(original)), { ok: true, status: "duplicate" });
  assert.deepEqual(index.addScore({ ...original, evidence_digests: [digest("9")] }), {
    ok: false,
    reason: "SCORE_ID_COLLISION",
  });
});

test("rejects decisions for unknown candidates and changed candidate or artifact digests", () => {
  const sourceCandidate = candidate();
  const unknownIndex = createLifecycleIndex();
  assert.deepEqual(unknownIndex.addApproval(approval(sourceCandidate)), {
    ok: false,
    reason: "UNKNOWN_CANDIDATE",
  });

  const index = createLifecycleIndex();
  index.addCandidate(sourceCandidate);
  assert.deepEqual(index.addApproval(approval(sourceCandidate, { candidate_digest: digest("9") })), {
    ok: false,
    reason: "CANDIDATE_DIGEST_MISMATCH",
  });
  assert.deepEqual(index.addApproval(approval(sourceCandidate, { reviewed_redacted_artifact_digest: digest("8") })), {
    ok: false,
    reason: "ARTIFACT_DIGEST_MISMATCH",
  });
});

test("allows one digest-bound candidate decision with duplicate idempotency", () => {
  const index = createLifecycleIndex();
  const sourceCandidate = candidate();
  const decision = approval(sourceCandidate);
  assert.deepEqual(index.addCandidate(sourceCandidate), { ok: true, status: "accepted" });
  assert.deepEqual(index.addApproval(decision), { ok: true, status: "accepted" });
  assert.deepEqual(index.addApproval(structuredClone(decision)), { ok: true, status: "duplicate" });
});

test("rejects divergent approval ID collisions and a second or conflicting decision", () => {
  const sourceCandidate = candidate();
  const decision = approval(sourceCandidate);

  const collisionIndex = createLifecycleIndex();
  collisionIndex.addCandidate(sourceCandidate);
  collisionIndex.addApproval(decision);
  assert.deepEqual(collisionIndex.addApproval({ ...decision, decision: "rejected" }), {
    ok: false,
    reason: "APPROVAL_ID_COLLISION",
  });

  for (const secondDecision of ["approved", "rejected"] as const) {
    const index = createLifecycleIndex();
    index.addCandidate(sourceCandidate);
    index.addApproval(decision);
    assert.deepEqual(index.addApproval(approval(sourceCandidate, {
      approval_id: "01945b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
      decision: secondDecision,
    })), { ok: false, reason: "CANDIDATE_ALREADY_DECIDED" });
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  createEvalCandidate,
  createEvalCandidateDecision,
  createEventValidators,
  sha256Digest,
} from "../../packages/events/src/index.ts";

const digest = (character: string) => character.repeat(64);

test("constructs validated content-free pending candidates", () => {
  const candidate = createEvalCandidate({
    candidate_id: "01925b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:06:00Z",
    skill_id: "pragman:review",
    skill_digest: digest("a"),
    corpus_id: "review-failures",
    source_event_digests: [digest("b")],
    failure_codes: ["verification-failed"],
    redacted_artifact_alias: "artifact-one",
    redacted_artifact_digest: digest("c"),
  });
  assert.equal(candidate.approval_status, "pending");
  assert.equal(createEventValidators().candidate(candidate).ok, true);
  assert.equal("prompt" in candidate, false);
  assert.equal("output" in candidate, false);
  assert.equal("corpus_patch" in candidate, false);
});

test("constructs a validated user decision bound to candidate and artifact digests", () => {
  const candidate = createEvalCandidate({
    candidate_id: "01925b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:06:00Z",
    skill_id: "pragman:review",
    skill_digest: digest("a"),
    corpus_id: "review-failures",
    source_event_digests: [digest("b")],
    failure_codes: ["verification-failed"],
    redacted_artifact_alias: "artifact-one",
    redacted_artifact_digest: digest("c"),
  });
  const approval = createEvalCandidateDecision({
    approval_id: "01935b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:07:00Z",
    candidate,
    decision: "approved",
    reviewed_redacted_artifact_digest: candidate.redacted_artifact_digest,
  });
  assert.equal(approval.candidate_digest, sha256Digest(candidate));
  assert.equal(approval.approval_source, "user");
  assert.equal(createEventValidators().approval(approval).ok, true);
});

test("candidate constructors reject content fields and expose no corpus mutation", async () => {
  assert.throws(() => createEvalCandidate({
    candidate_id: "01925b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:06:00Z",
    skill_id: "pragman:review",
    skill_digest: digest("a"),
    corpus_id: "review-failures",
    source_event_digests: [digest("b")],
    failure_codes: ["verification-failed"],
    redacted_artifact_alias: "artifact-one",
    redacted_artifact_digest: digest("c"),
    prompt: "private",
  } as never), /SCHEMA_INVALID/);
  assert.equal("writeEvalCorpus" in await import("../../packages/events/src/index.ts"), false);
});

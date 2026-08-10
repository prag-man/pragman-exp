import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../../packages/cli/src/args.ts";
import { executeTuneCommand } from "../../packages/cli/src/commands/tune.ts";
import { appendDurable, createEvalCandidate, createEvalCandidateDecision, sha256Digest } from "../../packages/events/src/index.ts";

const digest = (character: string) => character.repeat(64);

async function approvedState() {
  const root = await mkdtemp(join(tmpdir(), "pragman-tune-state-"));
  const config = await mkdtemp(join(tmpdir(), "pragman-tune-config-"));
  const candidate = createEvalCandidate({
    candidate_id: "01925b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:06:00Z",
    skill_id: "pragman:analyze",
    skill_digest: digest("a"),
    corpus_id: "analysis-failures",
    source_event_digests: [digest("b")],
    failure_codes: ["verification-failed"],
    redacted_artifact_alias: "artifact-one",
    redacted_artifact_digest: digest("c"),
  });
  const approval = createEvalCandidateDecision(candidate, {
    approval_id: "01935b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:07:00Z",
    decision: "approved",
    reviewed_redacted_artifact_digest: candidate.redacted_artifact_digest,
  });
  await appendDurable(root, "eval-candidates", candidate);
  await appendDurable(root, "candidate-approvals", approval);
  const candidateDigest = sha256Digest(candidate);
  const input = {
    candidate_id: candidate.candidate_id,
    candidate_digest: candidateDigest,
    scenario: {
      scenario_id: "verification-regression",
      failure_codes: ["verification-failed"],
      acceptance_invariants: ["The final result must include fresh verification evidence."],
    },
    evaluation: {
      status: "COMPARABLE",
      passed: true,
      candidate_digest: candidateDigest,
      skill_digest: candidate.skill_digest,
      evidence_digest: digest("d"),
    },
  } as const;
  return { root, config, candidate, input };
}

test("argument grammar recognizes tune", () => {
  assert.equal(parseArguments(["tune"]).command, "tune");
});

test("tune previews then applies an approved evaluated candidate only to a private overlay", async () => {
  const fixture = await approvedState();
  const io = { readStdin: async () => JSON.stringify(fixture.input) };
  const preview = await executeTuneCommand(parseArguments(["tune", "--state-root", fixture.root, "--config", fixture.config]), io);
  assert.equal(preview.exitCode, 0);
  assert.equal(preview.envelope.ok, true);
  const previewData = preview.envelope.data as { mutated: boolean; preview_digest: string };
  assert.equal(previewData.mutated, false);

  const stale = await executeTuneCommand(parseArguments(["tune", "--state-root", fixture.root, "--config", fixture.config, "--apply", digest("e")]), io);
  assert.notEqual(stale.exitCode, 0);

  const applied = await executeTuneCommand(parseArguments(["tune", "--state-root", fixture.root, "--config", fixture.config, "--apply", previewData.preview_digest]), io);
  assert.equal(applied.exitCode, 0);
  const target = join(fixture.config, "overlays", "pragman--analyze", "eval-candidates.jsonl");
  const persisted = JSON.parse((await readFile(target, "utf8")).trim()) as { candidate_id: string; approval_status: string };
  assert.equal(persisted.candidate_id, fixture.candidate.candidate_id);
  assert.equal(persisted.approval_status, "approved");
});

test("tune rejects candidates without approval or matching evaluation evidence", async () => {
  const fixture = await approvedState();
  const mismatched = structuredClone(fixture.input) as Record<string, any>;
  mismatched.evaluation.skill_digest = digest("e");
  const failed = await executeTuneCommand(
    parseArguments(["tune", "--state-root", fixture.root, "--config", fixture.config]),
    { readStdin: async () => JSON.stringify(mismatched) },
  );
  assert.notEqual(failed.exitCode, 0);

  const emptyState = await mkdtemp(join(tmpdir(), "pragman-tune-empty-"));
  const missing = await executeTuneCommand(
    parseArguments(["tune", "--state-root", emptyState, "--config", fixture.config]),
    { readStdin: async () => JSON.stringify(fixture.input) },
  );
  assert.notEqual(missing.exitCode, 0);
});

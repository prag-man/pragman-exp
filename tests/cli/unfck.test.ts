import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../../packages/cli/src/args.ts";
import { executeChangesCommand } from "../../packages/cli/src/commands/changes.ts";
import { executeEvalCommand } from "../../packages/cli/src/commands/eval.ts";
import { loadTuneOverlayPreferences } from "../../packages/cli/src/commands/provider-support.ts";
import { executeSessionsCommand } from "../../packages/cli/src/commands/sessions.ts";
import { executeTuneCommand } from "../../packages/cli/src/commands/tune.ts";
import {
  appendDurable,
  createEvalCandidateDecision,
  sha256Digest,
  type EvalCandidate,
} from "../../packages/events/src/index.ts";
import { createProviderRegistry } from "../../packages/provider-registry/src/index.ts";

const digest = (character: string) => character.repeat(64);
const noInput = { readStdin: async () => "" };
const repositoryRoot = new URL("../../", import.meta.url).pathname;

async function sessionFixture() {
  const root = await mkdtemp(join(tmpdir(), "pragman-unfck-"));
  const source = join(root, "source");
  const events = join(root, "events");
  const config = join(root, "config");
  await mkdir(source);
  await mkdir(config);
  await writeFile(join(source, "session.jsonl"), [
    { timestamp: "2026-08-10T10:00:00.000Z", type: "session_meta", payload: { id: "demo", version: "1" } },
    { timestamp: "2026-08-10T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: "api_key=secret-1234567890 please fix it" } },
    { timestamp: "2026-08-10T10:00:02.000Z", type: "event_msg", payload: { type: "context_compacted" } },
  ].map(JSON.stringify).join("\n"));
  const selection = {
    sources: [{ adapter: "codex", root: source, project_alias: "demo" }],
    from: "2026-08-01T00:00:00.000Z",
    through: "2026-08-31T23:59:59.999Z",
    project_aliases: ["demo"],
    content_categories: ["messages", "lifecycle"],
    privacy_depth: "safe",
  };
  return { root, source, events, config, selection };
}

function candidateProposal() {
  return {
    candidate_id: "01925b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:00:00.000Z",
    skill_id: "pragman:analyze",
    skill_digest: digest("c"),
    corpus_id: "session-failures",
    failure_codes: ["verification-gap"],
    redacted_artifact_alias: "session-analysis-one",
  };
}

function analysisInput(selection: Record<string, unknown>) {
  return {
    selection,
    context: {
      intended_outcome: "Ship a verified bounded change",
      external_constraints: "No external blockers",
      intentional_waits: "The compaction was not intentional",
    },
    candidate: candidateProposal(),
  };
}

function registry(skillDigest: string) {
  return createProviderRegistry({
    capabilities: [{ schema_version: 1, id: "analyze-work-history", stage: 10, depends_on: [], result_contract: "provider-result-v1" }],
    providers: [{
      schema_version: 1,
      id: "pragman:analyze",
      source: "prag-man/pragman-exp",
      source_version: "0.1.0",
      trust: "bundled",
      capabilities: ["analyze-work-history"],
      host_support: ["codex"],
      invoke: { kind: "native-skill", skill_id: "pragman:analyze" },
      context_policy: { accepted_classes: ["task-contract"], maximum_sensitivity: "internal", accepts_redacted_excerpts: false },
      side_effects: ["read-files"],
      workflow_weight: "light",
      result_contract: "provider-result-v1",
    }],
    discoveries: [{
      source: "prag-man/pragman-exp",
      skill_id: "pragman:analyze",
      version: "0.1.0",
      install_scope: "user",
      path_alias: "codex:user:pragman-analyze",
      digest: skillDigest,
    }],
  });
}

async function writePassingEvidence(eventRoot: string, candidate: EvalCandidate) {
  const candidateDigest = sha256Digest(candidate);
  const evidenceId = "approved-session-candidate-eval";
  const evaluated = await executeEvalCommand(parseArguments(["eval", "run", "--state-root", eventRoot]), {
    readStdin: async () => JSON.stringify({
      scenario_file: join(repositoryRoot, "evals/fixtures/skill-events/baseline.json"),
      observed_file: join(repositoryRoot, "evals/fixtures/skill-events/forward.json"),
      candidate_digest: candidateDigest,
      evidence_id: evidenceId,
    }),
  });
  assert.equal(evaluated.exitCode, 0, JSON.stringify(evaluated.envelope));
  const evalData = evaluated.envelope.ok ? evaluated.envelope.data as Record<string, any> : {};
  return {
    candidate_id: candidate.candidate_id,
    candidate_digest: candidateDigest,
    scenario: { scenario_id: "positive-route", failure_codes: ["verification-gap"], acceptance_invariants: ["A verified outcome is required"] },
    evaluation: { evidence_id: evidenceId, artifact_digest: evalData.artifact_digest },
  };
}

test("unfck analysis previews then explicitly creates a content-free pending eval candidate", async () => {
  const fixture = await sessionFixture();
  const argv = ["sessions", "analyze", "--state-root", fixture.events, "--config", fixture.config];
  const input = analysisInput(fixture.selection);
  const preview = await executeSessionsCommand(parseArguments(argv), { readStdin: async () => JSON.stringify(input) });
  assert.equal(preview.exitCode, 0);
  assert.equal(preview.envelope.ok, true);
  const data = preview.envelope.ok ? preview.envelope.data as Record<string, any> : {};
  assert.equal(data.mutation_allowed, false);
  assert.equal(data.candidate_creation.mutated, false);
  assert.equal(data.candidate_creation.candidate.approval_status, "pending");
  assert.equal(JSON.stringify(data).includes(fixture.source), false);
  assert.equal(JSON.stringify(data).includes("secret-1234567890"), false);

  const stale = await executeSessionsCommand(parseArguments([...argv, "--apply", digest("0")]), { readStdin: async () => JSON.stringify(input) });
  assert.equal(stale.exitCode, 5);
  const applied = await executeSessionsCommand(
    parseArguments([...argv, "--apply", data.candidate_creation.preview_digest]),
    { readStdin: async () => JSON.stringify(input) },
  );
  assert.equal(applied.exitCode, 0);
  const appliedData = applied.envelope.ok ? applied.envelope.data as Record<string, any> : {};
  assert.equal(appliedData.candidate_creation.mutated, true);
  assert.equal(appliedData.candidate_creation.append_status, "appended");

  await writeFile(join(fixture.events, ".events-mutation.lock"), "busy\n");
  const busy = await executeSessionsCommand(
    parseArguments([...argv, "--apply", data.candidate_creation.preview_digest]),
    { readStdin: async () => JSON.stringify(input) },
  );
  assert.equal(busy.exitCode, 6);
  assert.equal(busy.envelope.ok ? null : busy.envelope.error.retryable, true);
  await rm(join(fixture.events, ".events-mutation.lock"));
});

test("unfck candidate approval is invalidated when selected evidence changes without changing aggregate metrics", async () => {
  const fixture = await sessionFixture();
  const argv = ["sessions", "analyze", "--state-root", fixture.events, "--config", fixture.config];
  const input = analysisInput(fixture.selection);
  const first = await executeSessionsCommand(parseArguments(argv), { readStdin: async () => JSON.stringify(input) });
  const firstData = first.envelope.ok ? first.envelope.data as Record<string, any> : {};
  const path = join(fixture.source, "session.jsonl");
  await writeFile(path, (await readFile(path, "utf8")).replace("please fix it", "please ship it"));
  const second = await executeSessionsCommand(parseArguments(argv), { readStdin: async () => JSON.stringify(input) });
  const secondData = second.envelope.ok ? second.envelope.data as Record<string, any> : {};
  assert.notEqual(firstData.candidate_creation.preview_digest, secondData.candidate_creation.preview_digest);
});

test("unfck candidate creation fails closed when context is missing or proposal fields are not content-free", async () => {
  const fixture = await sessionFixture();
  const argv = ["sessions", "analyze", "--state-root", fixture.events, "--config", fixture.config];
  const incomplete = await executeSessionsCommand(parseArguments(argv), {
    readStdin: async () => JSON.stringify({ selection: fixture.selection, context: {}, candidate: candidateProposal() }),
  });
  assert.equal(incomplete.exitCode, 3);
  const unsafe = await executeSessionsCommand(parseArguments(argv), {
    readStdin: async () => JSON.stringify({
      ...analysisInput(fixture.selection),
      candidate: { ...candidateProposal(), transcript: "api_key=secret-1234567890" },
    }),
  });
  assert.equal(unsafe.exitCode, 2);
  assert.equal(JSON.stringify(unsafe.envelope).includes("secret-1234567890"), false);

  const secret = "sk-proj-abcdefghijklmnop";
  const contextual = analysisInput(fixture.selection);
  contextual.context.external_constraints = `A credential was blocked: ${secret}`;
  const redacted = await executeSessionsCommand(parseArguments(argv), { readStdin: async () => JSON.stringify(contextual) });
  assert.equal(redacted.exitCode, 0);
  assert.equal(JSON.stringify(redacted.envelope).includes(secret), false);
});

test("unfck cannot create a candidate from an empty selected corpus", async () => {
  const fixture = await sessionFixture();
  const empty = join(fixture.root, "empty-source");
  await mkdir(empty);
  const input = analysisInput({
    ...fixture.selection,
    sources: [{ adapter: "codex", root: empty, project_alias: "demo" }],
  });
  const result = await executeSessionsCommand(
    parseArguments(["sessions", "analyze", "--state-root", fixture.events, "--config", fixture.config]),
    { readStdin: async () => JSON.stringify(input) },
  );
  assert.notEqual(result.exitCode, 0);
});

test("approved evaluated tuning affects runtime preference and changes rollback restores exact prior overlay", async () => {
  const fixture = await sessionFixture();
  const analysis = analysisInput(fixture.selection);
  const analyzeArgs = ["sessions", "analyze", "--state-root", fixture.events, "--config", fixture.config];
  const preview = await executeSessionsCommand(parseArguments(analyzeArgs), { readStdin: async () => JSON.stringify(analysis) });
  const previewData = preview.envelope.ok ? preview.envelope.data as Record<string, any> : {};
  const applied = await executeSessionsCommand(
    parseArguments([...analyzeArgs, "--apply", previewData.candidate_creation.preview_digest]),
    { readStdin: async () => JSON.stringify(analysis) },
  );
  const candidate = (applied.envelope.ok ? (applied.envelope.data as Record<string, any>).candidate_creation.candidate : null) as EvalCandidate;
  await appendDurable(fixture.events, "candidate-approvals", createEvalCandidateDecision(candidate, {
    approval_id: "01935b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:30:00.000Z",
    decision: "approved",
    reviewed_redacted_artifact_digest: candidate.redacted_artifact_digest,
  }));
  const tuneInput = await writePassingEvidence(fixture.events, candidate);

  const skillDirectory = join(fixture.config, "overlays", "pragman--analyze");
  const target = join(skillDirectory, "eval-candidates.jsonl");
  const previous = '{"existing":"entry"}\n';
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(target, previous);

  const tuneArgs = ["tune", "--state-root", fixture.events, "--config", fixture.config];
  const tunePreview = await executeTuneCommand(parseArguments(tuneArgs), { readStdin: async () => JSON.stringify(tuneInput) });
  assert.equal(tunePreview.exitCode, 0, JSON.stringify(tunePreview.envelope));
  const tunePreviewData = tunePreview.envelope.ok ? tunePreview.envelope.data as Record<string, any> : {};
  await mkdir(join(fixture.config, ".tune-lock"));
  const busy = await executeTuneCommand(
    parseArguments([...tuneArgs, "--apply", tunePreviewData.preview_digest]),
    { readStdin: async () => JSON.stringify(tuneInput) },
  );
  assert.equal(busy.exitCode, 6);
  assert.equal(busy.envelope.ok ? null : busy.envelope.error.retryable, true);
  await rm(join(fixture.config, ".tune-lock"), { recursive: true });
  const tuned = await executeTuneCommand(
    parseArguments([...tuneArgs, "--apply", tunePreviewData.preview_digest]),
    { readStdin: async () => JSON.stringify(tuneInput) },
  );
  assert.equal(tuned.exitCode, 0);
  const tunedData = tuned.envelope.ok ? tuned.envelope.data as Record<string, any> : {};
  assert.equal(typeof tunedData.change_id, "string");

  const runtime = await loadTuneOverlayPreferences(fixture.config, registry(candidate.skill_digest));
  assert.deepEqual(runtime.preferences, ["pragman:analyze"]);
  assert.deepEqual(runtime.warnings, []);
  const drifted = await loadTuneOverlayPreferences(fixture.config, registry(digest("d")));
  assert.deepEqual(drifted.preferences, []);
  assert.deepEqual(drifted.warnings, ["TUNE_OVERLAY_SKILL_DRIFT"]);

  const listed = await executeChangesCommand(parseArguments(["changes", "list", "--config", fixture.config]), noInput);
  const listedData = listed.envelope.ok ? listed.envelope.data as Record<string, any> : {};
  assert.equal(listedData.tune_changes[0].change_id, tunedData.change_id);
  assert.deepEqual(Object.keys(listedData.tune_changes[0]).sort(), ["applied_at", "candidate_id", "change_id", "rollback", "target_alias"]);
  assert.deepEqual(Object.keys(listedData.tune_changes[0].rollback).sort(), ["available", "rolled_back"]);

  const rollbackArgs = ["changes", "rollback", "--change", tunedData.change_id, "--config", fixture.config];
  const rollbackPreview = await executeChangesCommand(parseArguments(rollbackArgs), noInput);
  assert.equal(rollbackPreview.exitCode, 0);
  const rollbackPreviewData = rollbackPreview.envelope.ok ? rollbackPreview.envelope.data as Record<string, any> : {};
  const rolledBack = await executeChangesCommand(
    parseArguments([...rollbackArgs, "--apply", rollbackPreviewData.preview_digest]),
    noInput,
  );
  assert.equal(rolledBack.exitCode, 0);
  assert.equal(await readFile(target, "utf8"), previous);
  assert.deepEqual((await loadTuneOverlayPreferences(fixture.config, registry(candidate.skill_digest))).preferences, []);
});

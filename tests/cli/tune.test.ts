import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../../packages/cli/src/args.ts";
import { executeTuneCommand } from "../../packages/cli/src/commands/tune.ts";
import { appendDurable, createEvalCandidate, createEvalCandidateDecision, sha256Digest } from "../../packages/events/src/index.ts";

const digest = (character: string) => character.repeat(64);
const repositoryRoot = new URL("../../", import.meta.url).pathname;
const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;

async function approvedState(options: { candidateSkillDigest?: string; artifactCandidateDigest?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pragman-tune-state-"));
  const config = await mkdtemp(join(tmpdir(), "pragman-tune-config-"));
  const candidate = createEvalCandidate({
    candidate_id: "01925b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:06:00Z",
    skill_id: "pragman:analyze",
    skill_digest: options.candidateSkillDigest ?? digest("c"),
    corpus_id: "analysis-failures",
    source_event_digests: [digest("b")],
    failure_codes: ["verification-failed"],
    redacted_artifact_alias: "artifact-one",
    redacted_artifact_digest: digest("d"),
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
  const evidenceId = "approved-candidate-eval";
  const evaluated = spawnSync(process.execPath, [cli, "eval", "run", "--state-root", root, "--json"], {
    encoding: "utf8",
    input: JSON.stringify({
      scenario_file: join(repositoryRoot, "evals/fixtures/skill-events/baseline.json"),
      observed_file: join(repositoryRoot, "evals/fixtures/skill-events/forward.json"),
      evidence_id: evidenceId,
      candidate_digest: options.artifactCandidateDigest ?? candidateDigest,
    }),
  });
  assert.equal(evaluated.status, 0, evaluated.stderr);
  const evalData = JSON.parse(evaluated.stdout).data as { artifact_digest: string };
  const input = {
    candidate_id: candidate.candidate_id,
    candidate_digest: candidateDigest,
    scenario: {
      scenario_id: "positive-route",
      failure_codes: ["verification-failed"],
      acceptance_invariants: ["The final result must include fresh verification evidence."],
    },
    evaluation: { evidence_id: evidenceId, artifact_digest: evalData.artifact_digest },
  } as const;
  return { root, config, candidate, input, evidencePath: join(root, "eval-evidence", `${evidenceId}.json`) };
}

test("argument grammar recognizes tune", () => {
  assert.equal(parseArguments(["tune"]).command, "tune");
});

test("tune previews then applies verified evidence to a journaled private overlay", async () => {
  const fixture = await approvedState();
  const io = { readStdin: async () => JSON.stringify(fixture.input) };
  const preview = await executeTuneCommand(parseArguments(["tune", "--state-root", fixture.root, "--config", fixture.config]), io);
  assert.equal(preview.exitCode, 0);
  assert.equal(preview.envelope.ok, true);
  const previewData = preview.envelope.data as { mutated: boolean; preview_digest: string };
  assert.equal(previewData.mutated, false);
  await assert.rejects(lstat(join(fixture.config, "overlays")), { code: "ENOENT" });

  const stale = await executeTuneCommand(parseArguments(["tune", "--state-root", fixture.root, "--config", fixture.config, "--apply", digest("e")]), io);
  assert.notEqual(stale.exitCode, 0);

  const applied = await executeTuneCommand(parseArguments(["tune", "--state-root", fixture.root, "--config", fixture.config, "--apply", previewData.preview_digest]), io);
  assert.equal(applied.exitCode, 0);
  const target = join(fixture.config, "overlays", "pragman--analyze", "eval-candidates.jsonl");
  const persisted = JSON.parse((await readFile(target, "utf8")).trim()) as { candidate_id: string; approval_status: string };
  assert.equal(persisted.candidate_id, fixture.candidate.candidate_id);
  assert.equal(persisted.approval_status, "approved");
  const history = (await readFile(join(fixture.config, "history", "tune-changes.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(history.length, 1);
  assert.equal(history[0].candidate_id, fixture.candidate.candidate_id);
  assert.equal(history[0].rollback.available, true);
  assert.equal((await readFile(join(fixture.config, "history", "snapshots", `${history[0].base_digest}.bin`), "utf8")).length, 0);
});

test("tune rejects caller-asserted pass status and arbitrary evidence paths", async () => {
  const fixture = await approvedState();
  const asserted = structuredClone(fixture.input) as Record<string, any>;
  asserted.evaluation.status = "COMPARABLE";
  asserted.evaluation.passed = true;
  asserted.evaluation.skill_digest = fixture.candidate.skill_digest;
  const failed = await executeTuneCommand(
    parseArguments(["tune", "--state-root", fixture.root, "--config", fixture.config]),
    { readStdin: async () => JSON.stringify(asserted) },
  );
  assert.notEqual(failed.exitCode, 0);

  const escaped = structuredClone(fixture.input) as Record<string, any>;
  escaped.evaluation.evidence_id = "../../outside";
  const escapedResult = await executeTuneCommand(
    parseArguments(["tune", "--state-root", fixture.root, "--config", fixture.config]),
    { readStdin: async () => JSON.stringify(escaped) },
  );
  assert.notEqual(escapedResult.exitCode, 0);
});

test("tune rejects tampered and symlinked evaluation artifacts", async () => {
  const tampered = await approvedState();
  const artifact = JSON.parse(await readFile(tampered.evidencePath, "utf8"));
  artifact.evidence.utility_lift = -0.25;
  artifact.evidence.skill_on_pass_rate = 0;
  await writeFile(tampered.evidencePath, `${JSON.stringify(artifact, null, 2)}\n`);
  const tamperedInput = structuredClone(tampered.input) as Record<string, any>;
  tamperedInput.evaluation.artifact_digest = sha256Digest(artifact);
  const tamperedResult = await executeTuneCommand(
    parseArguments(["tune", "--state-root", tampered.root, "--config", tampered.config]),
    { readStdin: async () => JSON.stringify(tamperedInput) },
  );
  assert.notEqual(tamperedResult.exitCode, 0);

  const linked = await approvedState();
  const outside = join(await mkdtemp(join(tmpdir(), "pragman-tune-outside-")), "evidence.json");
  await writeFile(outside, await readFile(linked.evidencePath));
  await rm(linked.evidencePath);
  await symlink(outside, linked.evidencePath);
  const linkedResult = await executeTuneCommand(
    parseArguments(["tune", "--state-root", linked.root, "--config", linked.config]),
    { readStdin: async () => JSON.stringify(linked.input) },
  );
  assert.notEqual(linkedResult.exitCode, 0);
});

test("tune binds evidence to the candidate, compared skill digest, and selected scenario", async () => {
  const wrongCandidate = await approvedState({ artifactCandidateDigest: digest("f") });
  const candidateResult = await executeTuneCommand(
    parseArguments(["tune", "--state-root", wrongCandidate.root, "--config", wrongCandidate.config]),
    { readStdin: async () => JSON.stringify(wrongCandidate.input) },
  );
  assert.notEqual(candidateResult.exitCode, 0);

  const wrongSkill = await approvedState({ candidateSkillDigest: digest("e") });
  const skillResult = await executeTuneCommand(
    parseArguments(["tune", "--state-root", wrongSkill.root, "--config", wrongSkill.config]),
    { readStdin: async () => JSON.stringify(wrongSkill.input) },
  );
  assert.notEqual(skillResult.exitCode, 0);

  const wrongScenario = await approvedState();
  const scenarioInput = structuredClone(wrongScenario.input) as Record<string, any>;
  scenarioInput.scenario.scenario_id = "missing-case";
  const scenarioResult = await executeTuneCommand(
    parseArguments(["tune", "--state-root", wrongScenario.root, "--config", wrongScenario.config]),
    { readStdin: async () => JSON.stringify(scenarioInput) },
  );
  assert.notEqual(scenarioResult.exitCode, 0);
});

test("tune rejects candidates without approval", async () => {
  const fixture = await approvedState();
  const emptyState = await mkdtemp(join(tmpdir(), "pragman-tune-empty-"));
  const missing = await executeTuneCommand(
    parseArguments(["tune", "--state-root", emptyState, "--config", fixture.config]),
    { readStdin: async () => JSON.stringify(fixture.input) },
  );
  assert.notEqual(missing.exitCode, 0);
});

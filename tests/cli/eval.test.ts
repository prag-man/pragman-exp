import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBundledEvalRunner } from "../../packages/cli/src/commands/eval.ts";

const root = new URL("../../", import.meta.url).pathname;
const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;
const scenario = join(root, "evals", "fixtures", "skill-events", "baseline.json");
const observed = join(root, "evals", "fixtures", "skill-events", "forward.json");

function runEval(stateRoot: string, descriptor: Record<string, unknown>, extraArguments: string[] = []) {
  return spawnSync(process.execPath, [cli, "eval", "run", "--state-root", stateRoot, "--json", ...extraArguments], {
    encoding: "utf8",
    input: JSON.stringify(descriptor),
  });
}

test("eval run writes immutable candidate-bound evidence inside the selected event state root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman eval cwd "));
  const stateRoot = join(directory, "state");
  const candidateDigest = "a".repeat(64);
  const evidenceId = "candidate-eval-one";

  const result = runEval(stateRoot, { scenario_file: scenario, observed_file: observed, candidate_digest: candidateDigest, evidence_id: evidenceId });

  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.data.runner_version, 2);
  assert.equal(envelope.data.evidence.mode, "skill-eval");
  assert.equal(envelope.data.evidence_id, evidenceId);
  assert.match(envelope.data.artifact_digest, /^[a-f0-9]{64}$/);
  const artifact = JSON.parse(await readFile(join(stateRoot, "eval-evidence", `${evidenceId}.json`), "utf8"));
  assert.equal(artifact.artifact_type, "pragman-eval-evidence");
  assert.equal(artifact.candidate_digest, candidateDigest);
  assert.equal(artifact.evidence.status, "COMPARABLE");
  assert.equal(envelope.data.artifact_digest.length, 64);
  assert.doesNotMatch(result.stderr, /fixtures|baseline|forward|candidate-eval-one/);

  let records: Array<Record<string, unknown>> = [];
  try {
    const partitions = await readdir(join(stateRoot, "skill-events"));
    records = (await readFile(join(stateRoot, "skill-events", partitions[0]!), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (records.length > 0) {
    const eventTypes = records.map((record) => record.event_type);
    assert.equal(eventTypes[0], "invoked");
    assert.equal(eventTypes.length <= 2, true);
    if (eventTypes.length === 2) assert.deepEqual(eventTypes, ["invoked", "completed"]);
    else assert.equal(envelope.warnings.includes("EVENT_OBSERVATION_DEADLINE_EXCEEDED"), true);
    assert.equal(records.every((record) => record.skill_id === "pragman:eval-run"), true);
    assert.equal(JSON.stringify(records).includes(directory), false);
  } else {
    assert.equal(envelope.warnings.includes("EVENT_OBSERVATION_LOCK_TIMEOUT"), true);
  }
});

test("eval evidence is create-only and rejects an existing target without changing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman-eval-existing-"));
  const stateRoot = join(directory, "state");
  const descriptor = { scenario_file: scenario, observed_file: observed, evidence_id: "fixed-evidence" };
  const first = runEval(stateRoot, descriptor);
  assert.equal(first.status, 0, first.stderr);
  const path = join(stateRoot, "eval-evidence", "fixed-evidence.json");
  const before = await readFile(path, "utf8");

  const second = runEval(stateRoot, descriptor);
  assert.notEqual(second.status, 0);
  assert.equal(await readFile(path, "utf8"), before);
  assert.match(second.stdout, /OUTPUT_ALREADY_EXISTS/);
});

test("eval evidence rejects a symlinked evidence directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman-eval-symlink-"));
  const stateRoot = join(directory, "state");
  const outside = join(directory, "outside");
  await mkdir(stateRoot);
  await mkdir(outside);
  await symlink(outside, join(stateRoot, "eval-evidence"));

  const result = runEval(stateRoot, { scenario_file: scenario, observed_file: observed, evidence_id: "escaped-evidence" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /OUTPUT_UNAVAILABLE/);
  await assert.rejects(readFile(join(outside, "escaped-evidence.json"), "utf8"), { code: "ENOENT" });
});

test("eval CLI rejects arbitrary runner execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman-eval-runner-"));
  const stateRoot = join(directory, "state");
  const marker = join(directory, "executed");
  const runner = join(directory, "runner.mjs");
  await writeFile(runner, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "yes");`);

  const result = runEval(stateRoot, { scenario_file: scenario, observed_file: observed }, ["--runner", runner]);
  assert.equal(result.status, 2);
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
});

test("eval runner resolution is relative to the installed module rather than cwd", async () => {
  const runner = await resolveBundledEvalRunner();
  assert.match(runner, /scripts\/run-evals\.mjs$/);
});

test("eval run rejects arbitrary output paths and unknown descriptor fields without reflecting them", () => {
  const selectedPath = "/private/example/secret-scenario.json";
  const result = runEval(join(tmpdir(), "pragman-eval-invalid"), {
    scenario_file: selectedPath,
    observed_file: selectedPath,
    output_file: selectedPath,
    prompt: "private",
  });
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout, /private|secret-scenario|prompt/);
  assert.doesNotMatch(result.stderr, /private|secret-scenario|prompt/);
});

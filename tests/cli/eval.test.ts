import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBundledEvalRunner } from "../../packages/cli/src/commands/eval.ts";

const root = new URL("../../", import.meta.url).pathname;
const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;

test("eval run uses the bundled skill-eval runner from an unrelated cwd and records content-free lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman eval cwd "));
  const stateRoot = join(directory, "state");
  const output = join(directory, "evidence.json");
  const scenario = join(root, "evals", "fixtures", "skill-events", "baseline.json");
  const observed = join(root, "evals", "fixtures", "skill-events", "forward.json");

  const result = spawnSync(process.execPath, [cli, "eval", "run", "--state-root", stateRoot, "--json"], {
    cwd: directory,
    encoding: "utf8",
    input: JSON.stringify({ scenario_file: scenario, observed_file: observed, output_file: output }),
  });

  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.data.runner_version, 2);
  assert.equal(envelope.data.evidence.mode, "skill-eval");
  assert.equal(JSON.parse(await readFile(output, "utf8")).status, "COMPARABLE");
  assert.doesNotMatch(result.stderr, /fixtures|baseline|forward|evidence\.json/);

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

test("eval runner resolution is relative to the installed module rather than cwd", async () => {
  const runner = await resolveBundledEvalRunner();
  assert.match(runner, /scripts\/run-evals\.mjs$/);
});

test("eval run rejects unknown descriptor fields without reflecting selected paths", () => {
  const selectedPath = "/private/example/secret-scenario.json";
  const result = spawnSync(process.execPath, [cli, "eval", "run", "--json"], {
    encoding: "utf8",
    input: JSON.stringify({ scenario_file: selectedPath, observed_file: selectedPath, output_file: selectedPath, prompt: "private" }),
  });
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout, /private|secret-scenario|prompt/);
  assert.doesNotMatch(result.stderr, /private|secret-scenario|prompt/);
});

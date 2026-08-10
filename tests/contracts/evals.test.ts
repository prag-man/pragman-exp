import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runner = new URL("../../scripts/run-evals.mjs", import.meta.url).pathname;

test("eval runner validates scenarios and records baseline and forward-test evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman-evals-"));
  const scenarioPath = join(directory, "scenario.json");
  const observedPath = join(directory, "observed.json");
  const evidencePath = join(directory, "evidence.json");
  await writeFile(scenarioPath, JSON.stringify({
    schema_version: 1,
    scenarios: [
      {
        id: "baseline-redaction",
        mode: "baseline",
        input: { text: "input-is-not-an-oracle" },
        expected_invariants: [{ path: "result", equals: { status: "safe", counts: [1, 2] } }],
      },
      {
        id: "forward-redaction",
        mode: "forward-test",
        input: { text: "another-input" },
        expected_invariants: [{ path: "result", equals: { status: "future", counts: [3] } }],
      },
    ],
  }));
  await writeFile(observedPath, JSON.stringify({
    "baseline-redaction": { result: { counts: [1, 2], status: "safe" } },
    "forward-redaction": { result: { status: "future", counts: [3] } },
  }));

  const result = spawnSync(process.execPath, [
    runner,
    scenarioPath,
    "--observed",
    observedPath,
    "--output",
    evidencePath,
  ], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.deepEqual(evidence.summary, { total: 2, passed: 2, failed: 0 });
  assert.deepEqual(evidence.results.map((item: { mode: string }) => item.mode), [
    "baseline",
    "forward-test",
  ]);
  assert.equal(evidence.results.every((item: { passed: boolean }) => item.passed), true);
  assert.equal(JSON.stringify(evidence).includes("counts"), false);
  assert.equal(JSON.stringify(evidence).includes("safe"), false);
});

test("eval runner rejects malformed scenarios without writing evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman-evals-invalid-"));
  const scenarioPath = join(directory, "scenario.json");
  const observedPath = join(directory, "observed.json");
  const evidencePath = join(directory, "evidence.json");
  await writeFile(scenarioPath, JSON.stringify({ schema_version: 1, scenarios: [{ id: "bad" }] }));
  await writeFile(observedPath, "{}");

  const result = spawnSync(process.execPath, [runner, scenarioPath, "--observed", observedPath, "--output", evidencePath], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid scenario/i);
});

test("eval runner requires both modes and never persists secret-bearing observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman-evals-secret-"));
  const scenarioPath = join(directory, "scenario.json");
  const observedPath = join(directory, "observed.json");
  const evidencePath = join(directory, "evidence.json");
  const secret = "sk-proj-super-secret-observed-value";
  await writeFile(scenarioPath, JSON.stringify({
    schema_version: 1,
    scenarios: [
      { id: "baseline-secret", mode: "baseline", input: {}, expected_invariants: [{ path: "token", equals: secret }] },
      { id: "forward-secret", mode: "forward-test", input: {}, expected_invariants: [{ path: "token", equals: secret }] },
    ],
  }));
  await writeFile(observedPath, JSON.stringify({
    "baseline-secret": { token: secret },
    "forward-secret": { token: secret },
  }));

  const result = spawnSync(process.execPath, [runner, scenarioPath, "--observed", observedPath, "--output", evidencePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const serializedEvidence = await readFile(evidencePath, "utf8");
  assert.doesNotMatch(serializedEvidence, /sk-proj|super-secret|token/);
  const evidence = JSON.parse(serializedEvidence);
  assert.match(evidence.results[0].invariants[0].expected_digest, /^[a-f0-9]{64}$/);
  assert.match(evidence.results[0].invariants[0].observed_digest, /^[a-f0-9]{64}$/);
});

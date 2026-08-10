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
  const evidencePath = join(directory, "evidence.json");
  await writeFile(scenarioPath, JSON.stringify({
    schema_version: 1,
    scenarios: [
      {
        id: "baseline-redaction",
        mode: "baseline",
        input: { text: "safe" },
        expected_invariants: [{ path: "text", equals: "safe" }],
      },
      {
        id: "forward-redaction",
        mode: "forward-test",
        input: { text: "future" },
        expected_invariants: [{ path: "text", equals: "future" }],
      },
    ],
  }));

  const result = spawnSync(process.execPath, [runner, scenarioPath, "--output", evidencePath], {
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
});

test("eval runner rejects malformed scenarios without writing evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman-evals-invalid-"));
  const scenarioPath = join(directory, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify({ schema_version: 1, scenarios: [{ id: "bad" }] }));

  const result = spawnSync(process.execPath, [runner, scenarioPath], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid scenario/i);
});


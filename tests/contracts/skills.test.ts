import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const validator = new URL("../../scripts/validate-skills.mjs", import.meta.url).pathname;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the public corpus contains exactly eight portable validated skills", () => {
  const result = spawnSync(process.execPath, [validator], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.skills.map((skill: { name: string }) => skill.name), [
    "pragman-analyze", "pragman-init", "pragman-prototype", "pragman-research",
    "pragman-router", "pragman-shape", "pragman-unfck", "pragman-workspace",
  ]);
  assert.equal(report.skills.every((skill: { scenarios: number; lines: number }) => skill.scenarios >= 3 && skill.lines <= 500), true);
  assert.equal(report.skills.every((skill: {
    trigger_cases: number;
    non_trigger_cases: number;
    evaluated_invariants: number;
    passed_invariants: number;
    behavioral_status: string;
  }) => skill.trigger_cases >= 1
    && skill.non_trigger_cases >= 1
    && skill.evaluated_invariants >= 4
    && skill.passed_invariants === skill.evaluated_invariants
    && skill.behavioral_status === "PASS"), true);
});

test("each public skill eval uses structured observations instead of self-attested pass flags", () => {
  const skillNames = [
    "pragman-analyze", "pragman-init", "pragman-prototype", "pragman-research",
    "pragman-router", "pragman-shape", "pragman-unfck", "pragman-workspace",
  ];
  for (const skillName of skillNames) {
    const baseline = JSON.parse(readFileSync(join(repositoryRoot, "skills", skillName, "evals", "baseline.json"), "utf8"));
    const forward = JSON.parse(readFileSync(join(repositoryRoot, "skills", skillName, "evals", "forward.json"), "utf8"));
    assert.equal(JSON.stringify(forward).includes('"passed"'), false, skillName);
    assert.equal(baseline.scenarios.some((scenario: { case_type: string }) => scenario.case_type === "trigger"), true, skillName);
    assert.equal(baseline.scenarios.some((scenario: { case_type: string }) => scenario.case_type === "non-trigger"), true, skillName);
    assert.equal(baseline.scenarios.every((scenario: { expected_invariants: unknown[] }) => scenario.expected_invariants.length > 0), true, skillName);
    assert.equal(forward.scenarios.every((scenario: { observation: unknown }) => scenario.observation && typeof scenario.observation === "object"), true, skillName);
  }
});

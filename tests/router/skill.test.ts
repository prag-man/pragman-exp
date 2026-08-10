import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("adaptive router skill keeps fast work fast and preserves operational approval boundaries", async () => {
  const root = new URL("../../skills/pragman-router/", import.meta.url);
  const [skill, compatibility, metadata, reference, baseline, forward] = await Promise.all([
    readFile(new URL("SKILL.md", root), "utf8"),
    readFile(new URL("COMPATIBILITY.md", root), "utf8"),
    readFile(new URL("agents/openai.yaml", root), "utf8"),
    readFile(new URL("references/routing-contract.md", root), "utf8"),
    readFile(new URL("evals/baseline.json", root), "utf8").then(JSON.parse),
    readFile(new URL("evals/forward.json", root), "utf8").then(JSON.parse),
  ]);
  assert.match(skill, /Adaptive behavior is the default/);
  assert.match(skill, /without an interview/);
  assert.match(skill, /preserve host-native approval/i);
  assert.match(skill, /CLI unavailable/);
  assert.match(reference, /request.*task_family.*desired_outcome/s);
  assert.deepEqual(baseline.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id), forward.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id));
  assert.equal(baseline.scenarios.some((scenario: { case_type: string }) => scenario.case_type === "non-trigger"), true);
  assert.equal(forward.scenarios.every((scenario: { observation: { triggered: boolean } }) => typeof scenario.observation.triggered === "boolean"), true);
  assert.equal(JSON.stringify(forward).includes('"passed"'), false);
  assert.equal([skill, compatibility, metadata, reference].join("\n").includes("/Users/"), false);
});

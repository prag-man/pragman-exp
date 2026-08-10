import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadSkill(name: string) {
  const root = new URL(`../../skills/${name}/`, import.meta.url);
  const [skill, compatibility, metadata, reference, baseline, forward] = await Promise.all([
    readFile(new URL("SKILL.md", root), "utf8"),
    readFile(new URL("COMPATIBILITY.md", root), "utf8"),
    readFile(new URL("agents/openai.yaml", root), "utf8"),
    readFile(new URL(`references/${name === "pragman-research" ? "research-methods" : "shape-contract"}.md`, root), "utf8"),
    readFile(new URL("evals/baseline.json", root), "utf8").then(JSON.parse),
    readFile(new URL("evals/forward.json", root), "utf8").then(JSON.parse),
  ]);
  return { skill, compatibility, metadata, reference, baseline, forward };
}

test("research selects the lightest sufficient method and covers all required scenario families", async () => {
  const artifact = await loadSkill("pragman-research");
  assert.match(artifact.skill, /decision it must enable/i);
  assert.match(artifact.skill, /independent fan-out/i);
  assert.match(artifact.skill, /source plan and egress boundary/i);
  assert.deepEqual(artifact.baseline.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id), ["quick", "technical-source-first", "fanout", "decision", "internal"]);
  assert.deepEqual(artifact.baseline.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id), artifact.forward.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id));
  assert.equal(artifact.forward.scenarios.every((scenario: { passed: boolean }) => scenario.passed), true);
  assert.equal(Object.values(artifact).map(String).join("\n").includes("/Users/"), false);
});

test("shape requires evidence, a smallest bet, success and kill criteria, and a bounded route", async () => {
  const artifact = await loadSkill("pragman-shape");
  for (const term of ["evidence", "smallest valuable", "non-goals", "success", "kill criterion", "dependencies", "route"]) assert.match(artifact.skill, new RegExp(term, "i"));
  assert.match(artifact.reference, /obvious-fast \| adaptive-default \| deep-deliberate \| operational/);
  assert.deepEqual(artifact.baseline.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id), ["vague-idea", "oversized-build", "low-evidence-bet"]);
  assert.deepEqual(artifact.baseline.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id), artifact.forward.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id));
  assert.equal(artifact.forward.scenarios.every((scenario: { passed: boolean }) => scenario.passed), true);
  assert.equal(Object.values(artifact).map(String).join("\n").includes("/Users/"), false);
});

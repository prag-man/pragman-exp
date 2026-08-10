import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deriveLane, type RouteInput } from "../../packages/router/src/index.ts";

const base: RouteInput = {
  request: "Do work", task_family: "implement", desired_outcome: "Done", deliverable_kind: "response-only",
  execution_mode: "serial", declared_side_effects: [], data_inputs: [], egress_destinations: [], urgency: "normal",
  uncertainties: [], scope_systems: [], estimated_sessions: "one", downstream_impact: "low", reversibility: "reversible",
  requested_capabilities: ["do-work"], workspace: null, project: null,
};

test("32 golden cases derive exactly eight examples for each lane", async () => {
  const fixtures = JSON.parse(await readFile(new URL("../../evals/golden/router.json", import.meta.url), "utf8")) as Array<{ id: string; expected: string; input: Partial<RouteInput> }>;
  assert.equal(fixtures.length, 32);
  assert.deepEqual(Object.fromEntries(["fast", "standard", "deep", "operational"].map((lane) => [lane, fixtures.filter((entry) => entry.expected === lane).length])), { fast: 8, standard: 8, deep: 8, operational: 8 });
  for (const fixture of fixtures) assert.equal(deriveLane({ ...base, ...fixture.input }), fixture.expected, fixture.id);
});

test("explicit lane may raise rigor but cannot lower operational or violate a prohibition", () => {
  assert.equal(deriveLane(base, { explicitLane: "deep" }), "deep");
  assert.equal(deriveLane({ ...base, declared_side_effects: ["deployment"] }, { explicitLane: "fast" }), "operational");
  assert.equal(deriveLane({ ...base, deliverable_kind: "project-change" }, { explicitLane: "fast", prohibitLaneDecrease: true }), "standard");
  assert.equal(deriveLane({ ...base, deliverable_kind: "project-change" }, { explicitLane: "fast" }), "fast");
});

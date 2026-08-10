import assert from "node:assert/strict";
import test from "node:test";

import { calculateOutcomeConfidence, rankProviders, type Provider, type RouteInput } from "../../packages/router/src/index.ts";

const input: RouteInput = {
  request: "Debug", task_family: "debug", desired_outcome: "Fixed", deliverable_kind: "response-only", execution_mode: "serial",
  declared_side_effects: [], data_inputs: [], egress_destinations: [], urgency: "normal", uncertainties: [], scope_systems: [], estimated_sessions: "one",
  downstream_impact: "low", reversibility: "reversible", requested_capabilities: ["diagnose"], workspace: null, project: null,
};

function provider(id: string, overrides: Partial<Provider> = {}): Provider {
  return { id, installed: true, handoffCapable: false, health: "healthy", compatible: true, capabilities: ["diagnose"], hostSupport: ["codex"], trust: "curated", contextMaximumSensitivity: "restricted", trustMaximumSensitivity: "restricted", sideEffects: [], workflowWeight: "light", ...overrides };
}

test("outcome confidence uses only 20 latest retained exact-context learnings", () => {
  const outcomes = Array.from({ length: 25 }, (_, index) => ({ providerId: "p:one", taskFamily: "debug" as const, sensitivity: "internal" as const, status: index < 20 ? "succeeded" as const : "failed" as const, retained: true, completedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`, learningId: `l-${index}` }));
  assert.equal(calculateOutcomeConfidence("p:one", "debug", "internal", outcomes), 13);
  assert.equal(calculateOutcomeConfidence("p:one", "research", "internal", outcomes), 0);
});

test("eligibility rejection is explained and ties use trust, narrowness, weight, then id", () => {
  const result = rankProviders([provider("z:broad", { capabilities: ["diagnose", "test"] }), provider("a:narrow"), provider("missing:one", { installed: false, handoffCapable: false })], input, { activeHost: "codex", allowedSideEffects: [] });
  assert.deepEqual(result.eligible.map((entry) => entry.provider.id), ["a:narrow", "z:broad"]);
  assert.equal(result.rejected[0]?.providerId, "missing:one");
  assert.ok(result.eligible[0]?.components.some((entry) => entry.reason === "required-capabilities" && entry.points === 10));
});

test("layered preferences and heavy-workflow penalties have exact score components", () => {
  const result = rankProviders([provider("p:one", { workflowWeight: "heavy" })], input, { activeHost: "codex", allowedSideEffects: [], explicitProviders: ["p:one"], projectPreferences: ["p:one"], workspacePreferences: ["p:one"], personalPreferences: ["p:one"] });
  const points = Object.fromEntries(result.eligible[0]!.components.map((entry) => [entry.reason, entry.points]));
  assert.deepEqual(points, { "explicit-selection": 1000, "project-preference": 300, "workspace-preference": 200, "personal-preference": 100, trust: 40, "required-capabilities": 10, "outcome-confidence": 0, "workflow-penalty": -50 });
  assert.equal(result.eligible[0]?.score, 1600);
});

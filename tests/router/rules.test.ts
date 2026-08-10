import assert from "node:assert/strict";
import test from "node:test";

import { applyRoutingRules, deriveRuleFacts, evaluateExpression, RouterError, type RouteInput, type RoutingRule } from "../../packages/router/src/index.ts";

const input: RouteInput = {
  request: "Debug it", task_family: "debug", desired_outcome: "Fixed", deliverable_kind: "project-change", execution_mode: "serial",
  declared_side_effects: ["project-file-write"], data_inputs: [{ id: "source", source_alias: "project", category: "source-code", sensitivity: "internal" }],
  egress_destinations: [], urgency: "normal", uncertainties: [], scope_systems: ["web"], estimated_sessions: "one",
  downstream_impact: "medium", reversibility: "reversible", requested_capabilities: ["diagnose"], workspace: "acme", project: "app",
};

test("structured predicates evaluate derived fields and nested boolean expressions", () => {
  const facts = deriveRuleFacts(input);
  assert.equal(facts.effective_sensitivity, "internal");
  assert.deepEqual(facts.data_categories, ["source-code"]);
  assert.equal(evaluateExpression({ all: [
    { field: "task_family", op: "eq", value: "debug" },
    { any: [{ field: "declared_side_effects", op: "contains", value: "project-file-write" }, { field: "urgency", op: "eq", value: "urgent" }] },
  ] }, facts), true);
});

test("matched rules accumulate capabilities/avoidance and can only raise lane and approval", () => {
  const rules: RoutingRule[] = [{ id: "debug", layer: "workspace", priority: 2, when: { all: [{ field: "task_family", op: "eq", value: "debug" }] }, action: { require_capabilities: ["test"], prefer: ["curated:debug"], avoid: ["bad:debug"], minimum_lane: "deep", require_approval: "route" } }];
  const result = applyRoutingRules(input, rules, "standard");
  assert.deepEqual(result.requiredCapabilities, ["diagnose", "test"]);
  assert.deepEqual(result.prefer, ["curated:debug"]);
  assert.deepEqual(result.avoid, ["bad:debug"]);
  assert.equal(result.minimumLane, "deep");
  assert.deepEqual(result.requiredApprovals, ["route"]);
});

test("same-layer same-priority incompatible approvals fail visibly", () => {
  const rules: RoutingRule[] = [
    { id: "a", layer: "project", priority: 1, when: { all: [{ field: "task_family", op: "eq", value: "debug" }] }, action: { require_approval: "action" } },
    { id: "b", layer: "project", priority: 1, when: { all: [{ field: "task_family", op: "eq", value: "debug" }] }, action: { require_approval: "target-specific" } },
  ];
  assert.throws(() => applyRoutingRules(input, rules, "standard"), (error) => error instanceof RouterError && error.code === "AMBIGUOUS_ROUTE");
});

import assert from "node:assert/strict";
import test from "node:test";

import { advanceSequence, chooseProviderSequence, routeTask, RouterError, selectFallback, type Capability, type Provider, type RouteInput } from "../../packages/router/src/index.ts";

const base: RouteInput = { request: "Ship it", task_family: "implement", desired_outcome: "Shipped", deliverable_kind: "project-change", execution_mode: "serial", declared_side_effects: ["project-file-write"], data_inputs: [], egress_destinations: [], urgency: "normal", uncertainties: [], scope_systems: ["repo"], estimated_sessions: "one", downstream_impact: "medium", reversibility: "reversible", requested_capabilities: ["plan", "build"], workspace: null, project: null };
const capabilities: Capability[] = [{ id: "plan", stage: 10, dependsOn: [], incompatibleWith: [] }, { id: "build", stage: 20, dependsOn: ["plan"], incompatibleWith: [] }];
function provider(id: string, caps: string[], overrides: Partial<Provider> = {}): Provider { return { id, installed: true, handoffCapable: false, health: "healthy", compatible: true, capabilities: caps, hostSupport: ["codex"], trust: "curated", contextMaximumSensitivity: "restricted", trustMaximumSensitivity: "restricted", sideEffects: ["project-file-write"], workflowWeight: "light", ...overrides }; }

test("route resolves personal/workspace/project modes and returns an immutable explainable contract", () => {
  const personal = routeTask(base, { providers: [provider("p:all", ["plan", "build"])], capabilities, activeHost: "codex", allowedSideEffects: ["project-file-write"] });
  assert.equal(personal.status, "ready");
  if (personal.status !== "ready") return;
  assert.equal(personal.contextMode, "personal-only");
  assert.deepEqual(personal.contract.providers, ["p:all"]);
  assert.ok(Object.isFrozen(personal.contract));
  const linked = routeTask({ ...base, project: "app", workspace: null }, { providers: [provider("p:all", ["plan", "build"])], capabilities, activeHost: "codex", allowedSideEffects: ["project-file-write"], projectLinks: { app: "acme" } });
  assert.equal(linked.status === "ready" ? linked.contract.workspace : null, "acme");
  assert.equal(linked.status === "ready" ? linked.contextMode : null, "project-linked");
  assert.equal(routeTask({ ...base, workspace: "acme" }, { providers: [], capabilities, activeHost: "codex", allowedSideEffects: [] }).contextMode, "workspace-only");
});

test("unlinked/mismatched projects, missing providers, and secondary conflicts are explicit", () => {
  assert.equal(routeTask({ ...base, project: "app" }, { providers: [], capabilities, activeHost: "codex", allowedSideEffects: [], projectLinks: { app: null } }).status, "needs-input");
  assert.equal(routeTask({ ...base, project: "app", workspace: "wrong" }, { providers: [], capabilities, activeHost: "codex", allowedSideEffects: [], projectLinks: { app: "acme" } }).status, "needs-input");
  assert.equal(routeTask(base, { providers: [], capabilities, activeHost: "codex", allowedSideEffects: ["project-file-write"] }).status, "missing-provider");
  const conflictOptions = { providers: [provider("p:all", ["plan", "build"])], capabilities, activeHost: "codex", allowedSideEffects: ["project-file-write"] as Array<"project-file-write">, secondaryConflicts: [{ path: "/region", values: ["india", "europe"] }] };
  assert.equal(routeTask(base, conflictOptions).status, "needs-input");
  assert.equal(routeTask(base, { ...conflictOptions, resolvedSecondaryConflicts: { "/region": "india" } }).status, "ready");
});

test("minimum set cover and serial dependency order are deterministic", () => {
  const ranked = [
    { provider: provider("p:build", ["build"]), score: 100, components: [], extraCapabilityCount: 0 },
    { provider: provider("p:plan", ["plan"]), score: 100, components: [], extraCapabilityCount: 0 },
    { provider: provider("p:all", ["plan", "build"], { workflowWeight: "heavy" }), score: 10, components: [], extraCapabilityCount: 0 },
  ];
  const selected = chooseProviderSequence(ranked, capabilities, ["plan", "build"], "serial");
  assert.deepEqual(selected.providers.map((entry) => entry.provider.id), ["p:all"]);
});

test("fanout dependency conflicts and requirements needing five providers return exact errors", () => {
  const ranked = [
    { provider: provider("p:plan", ["plan"]), score: 1, components: [], extraCapabilityCount: 0 },
    { provider: provider("p:build", ["build"]), score: 1, components: [], extraCapabilityCount: 0 },
  ];
  assert.throws(() => chooseProviderSequence(ranked, capabilities, ["plan", "build"], "independent-fanout"), (error) => error instanceof RouterError && error.code === "INVALID_EXECUTION_MODE");
  const fiveCaps = Array.from({ length: 5 }, (_, index) => ({ id: `c${index}`, stage: index, dependsOn: [], incompatibleWith: [] }));
  const fiveProviders = fiveCaps.map((capability) => ({ provider: provider(`p:${capability.id}`, [capability.id]), score: 1, components: [], extraCapabilityCount: 0 }));
  assert.throws(() => chooseProviderSequence(fiveProviders, fiveCaps, fiveCaps.map((entry) => entry.id), "serial"), (error) => error instanceof RouterError && error.code === "NEEDS_ROUTE_SPLIT");
});

test("approval matrix covers egress, file writes, external actions, and destructive targets", () => {
  const result = routeTask({ ...base, data_inputs: [{ id: "d", source_alias: "workspace", category: "docs", sensitivity: "confidential" }], egress_destinations: ["external-api"], declared_side_effects: ["destructive-action", "external-message"] }, { providers: [provider("p:all", ["plan", "build"], { sideEffects: ["destructive-action", "external-message"] })], capabilities, activeHost: "codex", allowedSideEffects: ["destructive-action", "external-message"] });
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.deepEqual(result.approvals.map((entry) => entry.type).sort(), ["egress", "host-action", "route", "target-specific"]);
});

test("same route returns cached contract, child depth stops at three, fallback is disclosed, cancellation stops sequence", () => {
  const options = { providers: [provider("p:all", ["plan", "build"]), provider("p:fallback", ["plan", "build"])], capabilities, activeHost: "codex", allowedSideEffects: ["project-file-write"] } as const;
  const first = routeTask(base, options);
  assert.equal(first.status, "ready");
  if (first.status !== "ready") return;
  const cached = routeTask(base, { ...options, routeId: first.contract.route_id, routerDepth: 1, existingContracts: new Map([[first.contract.route_id, first.contract]]) });
  assert.equal(cached.status, "existing");
  assert.throws(() => routeTask(base, { ...options, parentRouteId: first.contract.route_id, routerDepth: 4 }), (error) => error instanceof RouterError && error.code === "ROUTE_RECURSION");
  const fallback = selectFallback(options.providers[0]!, options.providers.slice(1), { allowedSideEffects: ["project-file-write"], sensitivity: "public" });
  assert.equal(fallback?.provider.id, "p:fallback");
  assert.equal(advanceSequence({ policy: "stop", currentIndex: 0, providerIds: ["a", "b"], cancelled: true }, { status: "succeeded" }), null);
  assert.equal(advanceSequence({ policy: "stop", currentIndex: 0, providerIds: ["a", "b"], cancelled: false }, { status: "failed" }), null);
});

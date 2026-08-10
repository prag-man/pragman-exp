import assert from "node:assert/strict";
import test from "node:test";

import {
  createRouteExecution,
  projectProviderHandoff,
  type RouteExecutionInput,
} from "../../host-adapters/orchestrator.ts";
import type {
  BoundedContext,
  CancellationResult,
  HostAdapter,
  InvocationHandle,
  ProviderResult,
} from "../../host-adapters/types.ts";
import type { ProviderDefinition } from "../../packages/provider-registry/src/index.ts";
import type { TaskContract } from "../../packages/router/src/index.ts";

const routeId = "01915b8c-7f2d-7a51-a9c0-1d4cb73b10ab";

function provider(id: string, capabilities: string[]): ProviderDefinition {
  return {
    schema_version: 1,
    id,
    source: `example/${id.replace(":", "-")}`,
    source_version: "1.0.0",
    trust: "curated",
    capabilities,
    host_support: ["codex"],
    invoke: { kind: "manual", instructions: [`Invoke ${id}.`] },
    context_policy: {
      accepted_classes: ["task-contract", "context-summary", "redacted-excerpt"],
      maximum_sensitivity: "confidential",
      accepts_redacted_excerpts: true,
    },
    side_effects: ["project-file-write"],
    workflow_weight: "light",
    result_contract: "provider-result-v1",
  };
}

function contract(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    schema_version: 1,
    route_id: routeId,
    parent_route_id: null,
    router_depth: 0,
    request_digest: "a".repeat(64),
    outcome: "Produce a verified implementation",
    lane: "standard",
    deliverable_kind: "project-change",
    execution_mode: "serial",
    workspace: null,
    project: null,
    in_scope: [],
    out_of_scope: [],
    assumptions: [],
    unresolved_conflicts: [],
    capabilities: ["plan", "build"],
    providers: ["test:plan", "test:build"],
    provider_assignments: [
      { provider_id: "test:plan", capabilities: ["plan"] },
      { provider_id: "test:build", capabilities: ["build"] },
    ],
    provider_sequence_policy: "stop",
    allowed_side_effects: ["project-file-write"],
    data_inputs: [],
    effective_sensitivity: "internal",
    egress_approvals: [],
    proof: [],
    stop_conditions: [],
    created_at: "2026-08-10T12:00:00Z",
    ...overrides,
  };
}

function result(handle: InvocationHandle, status: ProviderResult["status"]): ProviderResult {
  return {
    status,
    provider_id: handle.provider_id,
    route_id: handle.route_id,
    summary: status === "succeeded" ? "Verified provider result." : "Provider did not complete.",
    artifacts: [],
    evidence: status === "succeeded" ? ["e".repeat(64)] : [],
    verification: status === "succeeded" ? [{ code: "verified", passed: true }] : [],
    error: { code: status === "succeeded" ? null : status.toUpperCase(), retryable: false },
  };
}

function fakeAdapter(statuses: Record<string, ProviderResult["status"]>) {
  const invoked: Array<{ provider: ProviderDefinition; contract: BoundedContext["task_contract"] }> = [];
  const cancelled: string[] = [];
  const adapter: HostAdapter = {
    host: "codex",
    host_version: "1.4.0",
    health: () => "healthy",
    capabilities: () => ["discovery", "native-skill", "cancellation", "collection"],
    discover: async () => [],
    async invoke(selected, adapterContract) {
      invoked.push({ provider: selected, contract: structuredClone(adapterContract) });
      return {
        invocation_id: `invocation-${selected.id}`,
        provider_id: selected.id,
        route_id: adapterContract.route_id,
        mode: "native-skill",
        status: "running",
        execution_id: `execution-${selected.id}`,
        handoff_instructions: [],
      };
    },
    async cancel(handle): Promise<CancellationResult> {
      cancelled.push(handle.provider_id);
      return { cancelled: true, reason: null };
    },
    async collect(handle) { return result(handle, statuses[handle.provider_id] ?? "failed"); },
    sessionSources: async () => [],
  };
  return { adapter, invoked, cancelled };
}

function input(adapter: HostAdapter, routeContract = contract()): RouteExecutionInput {
  return {
    contract: routeContract,
    providers: [provider("test:plan", ["plan"]), provider("test:build", ["build"])],
    adapter,
    contexts: {},
  };
}

test("projects one exact bounded adapter handoff per assigned provider", () => {
  const routeContract = contract();
  const selected = provider("test:plan", ["plan"]);
  const handoff = projectProviderHandoff(routeContract, selected, { summaries: [], redacted_excerpts: [] });

  assert.deepEqual(handoff.contract.capabilities, ["plan"]);
  assert.deepEqual(handoff.contract.providers, ["test:plan"]);
  assert.deepEqual(handoff.contract.provider_assignments, [{ provider_id: "test:plan", capabilities: ["plan"] }]);
  assert.equal(handoff.contract.router_depth, 0);
  assert.deepEqual(handoff.context.task_contract, handoff.contract);
});

test("stop policy preserves route order and never invokes later providers after failure", async () => {
  const fake = fakeAdapter({ "test:plan": "failed", "test:build": "succeeded" });
  const execution = createRouteExecution(input(fake.adapter));
  const outcome = await execution.run();

  assert.equal(outcome.status, "failed");
  assert.deepEqual(fake.invoked.map((entry) => entry.provider.id), ["test:plan"]);
  assert.deepEqual(outcome.steps.map((step) => [step.provider_id, step.status]), [
    ["test:plan", "failed"],
    ["test:build", "skipped"],
  ]);
  assert.deepEqual(outcome.remaining_capabilities, ["plan", "build"]);
});

test("route succeeds only after normalized verified results cover every capability", async () => {
  const fake = fakeAdapter({ "test:plan": "succeeded", "test:build": "partial" });
  const incomplete = await createRouteExecution(input(fake.adapter)).run();
  assert.equal(incomplete.status, "partial");
  assert.deepEqual(incomplete.completed_capabilities, ["plan"]);
  assert.deepEqual(incomplete.remaining_capabilities, ["build"]);

  const unverifiedAdapter = fakeAdapter({ "test:plan": "succeeded", "test:build": "succeeded" });
  unverifiedAdapter.adapter.collect = async (handle) => ({ ...result(handle, "succeeded"), verification: [] });
  const unverified = await createRouteExecution(input(unverifiedAdapter.adapter)).run();
  assert.equal(unverified.status, "partial");
  assert.equal(unverified.steps[0]?.result?.error.code, "UNVERIFIED_SUCCESS");

  const completeAdapter = fakeAdapter({ "test:plan": "succeeded", "test:build": "succeeded" });
  const complete = await createRouteExecution(input(completeAdapter.adapter)).run();
  assert.equal(complete.status, "succeeded");
  assert.deepEqual(complete.completed_capabilities, ["plan", "build"]);

  const noExecutionAdapter = fakeAdapter({});
  const noExecution = await createRouteExecution(input(noExecutionAdapter.adapter, contract({
    capabilities: [], providers: [], provider_assignments: [], allowed_side_effects: [],
  }))).run();
  assert.equal(noExecution.status, "partial");
  assert.equal(noExecution.error.code, "NO_PROVIDER_EXECUTION");
});

test("fallback continues in order and succeeds only when a later provider covers the failed capability", async () => {
  const routeContract = contract({
    capabilities: ["build"],
    providers: ["test:plan", "test:build"],
    provider_assignments: [
      { provider_id: "test:plan", capabilities: ["build"] },
      { provider_id: "test:build", capabilities: ["build"] },
    ],
    provider_sequence_policy: "fallback",
  });
  const fake = fakeAdapter({ "test:plan": "failed", "test:build": "succeeded" });
  const executionInput = {
    ...input(fake.adapter, routeContract),
    providers: [provider("test:plan", ["build"]), provider("test:build", ["build"])],
  };
  const outcome = await createRouteExecution(executionInput).run();

  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(fake.invoked.map((entry) => entry.provider.id), ["test:plan", "test:build"]);
  assert.deepEqual(outcome.completed_capabilities, ["build"]);
});

test("cancellation propagates to every active fanout handle and prevents success", async () => {
  const invoked: InvocationHandle[] = [];
  const pending = new Map<string, (value: ProviderResult) => void>();
  const cancelled: string[] = [];
  const adapter: HostAdapter = {
    host: "codex",
    host_version: "1.4.0",
    health: () => "healthy",
    capabilities: () => ["discovery", "native-skill", "cancellation", "collection"],
    discover: async () => [],
    async invoke(selected) {
      const handle: InvocationHandle = {
        invocation_id: `invocation-${selected.id}`, provider_id: selected.id, route_id: routeId,
        mode: "native-skill", status: "running", execution_id: `execution-${selected.id}`, handoff_instructions: [],
      };
      invoked.push(handle);
      return handle;
    },
    async cancel(handle) {
      cancelled.push(handle.provider_id);
      pending.get(handle.provider_id)?.(result(handle, "cancelled"));
      return { cancelled: true, reason: null };
    },
    collect: async (handle) => new Promise((resolve) => pending.set(handle.provider_id, resolve)),
    sessionSources: async () => [],
  };
  const routeContract = contract({ execution_mode: "independent-fanout", provider_sequence_policy: "continue-independent" });
  const execution = createRouteExecution(input(adapter, routeContract));
  const running = execution.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(invoked.map((entry) => entry.provider_id), ["test:plan", "test:build"]);

  await execution.cancel();
  const outcome = await running;
  assert.equal(outcome.status, "cancelled");
  assert.deepEqual(cancelled, ["test:plan", "test:build"]);
  assert.ok(outcome.steps.every((step) => step.status === "cancelled"));
});

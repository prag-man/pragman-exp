import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  BoundedContextError,
  boundedContextContentDigest,
  createBoundedContext,
  type EgressApproval,
  type HostRuntime,
  type ProviderResult,
} from "../../host-adapters/types.ts";
import { createClaudeCodeHostAdapter } from "../../host-adapters/claude-code/index.ts";
import { createCodexHostAdapter } from "../../host-adapters/codex/index.ts";
import { createCursorHostAdapter } from "../../host-adapters/cursor/index.ts";
import type { ProviderDefinition } from "../../packages/provider-registry/src/index.ts";
import type { SkillEvent } from "../../packages/events/src/types.ts";

const digest = (character: string) => character.repeat(64);
const excerptDigest = (value: string) => createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
const routeId = "01915b8c-7f2d-7a51-a9c0-1d4cb73b10ab";
const approvalId = "01915b8c-7f2d-7a51-a9c0-1d4cb73b10ac";
const provider = (kind: "native-skill" | "prompt-handoff" | "manual" = "native-skill"): ProviderDefinition => ({
  schema_version: 1,
  id: "gstack:investigate",
  source: "garrytan/gstack",
  source_version: "1.2.0",
  trust: "curated",
  capabilities: ["diagnose-software-failure"],
  host_support: ["codex", "claude-code", "cursor"],
  invoke: kind === "native-skill"
    ? { kind, skill_id: "gstack:investigate" }
    : kind === "prompt-handoff"
      ? { kind, skill_id: "gstack:investigate", prompt: "Investigate under the supplied contract." }
      : { kind, instructions: ["Invoke gstack:investigate and return its normalized result."] },
  context_policy: { accepted_classes: ["task-contract", "context-summary", "redacted-excerpt"], maximum_sensitivity: "confidential", accepts_redacted_excerpts: true },
  side_effects: ["read-files", "run-commands"],
  workflow_weight: "standard",
  result_contract: "provider-result-v1",
});
const contract = {
  schema_version: 1 as const,
  route_id: routeId,
  router_depth: 0,
  request_digest: digest("a"),
  outcome: "Find the root cause",
  capabilities: ["diagnose-software-failure"],
  allowed_side_effects: ["read-files", "run-commands"],
  egress_approvals: [],
};

const approvedContext = (
  overrides: Partial<EgressApproval> = {},
  disclosure = {
    summaries: [{
      source_alias: "issue-summary", data_category: "incident", disclosed_field: "failure-summary",
      sensitivity: "internal" as const, summary: "Failure occurs after retry.",
    }],
    redacted_excerpts: [{
      source_alias: "log-excerpt", data_category: "logs", disclosed_field: "error-log",
      sensitivity: "confidential" as const, excerpt: "[REDACTED] timeout",
      digest: excerptDigest("[REDACTED] timeout"),
    }],
  },
) => {
  const approval: EgressApproval = {
    schema_version: 1,
    approval_id: approvalId,
    route_id: routeId,
    provider_id: provider().id,
    approved_at: "2026-08-10T11:00:00Z",
    expires_at: "2026-08-10T13:00:00Z",
    destination: "host-model",
    destination_id: "codex",
    source_aliases: ["issue-summary", "log-excerpt"],
    data_categories: ["incident", "logs"],
    disclosed_fields: ["error-log", "failure-summary"],
    effective_sensitivity: "confidential",
    purpose: "Invoke the selected provider with bounded context",
    retention: "provider-declared",
    further_calls_allowed: false,
    content_digest: boundedContextContentDigest(disclosure),
    ...overrides,
  };
  const approvedContract = { ...contract, egress_approvals: [approval] };
  return {
    approval,
    contract: approvedContract,
    context: createBoundedContext({ task_contract: approvedContract, ...disclosure }),
  };
};

test("bounded context accepts only compact summaries and byte-bound redacted excerpts", () => {
  const { context } = approvedContext();
  assert.equal(context.summaries.length, 1);

  assert.throws(() => createBoundedContext({ ...context, raw_path: "/private/work" } as never), BoundedContextError);
  assert.throws(() => createBoundedContext({
    ...context,
    summaries: [{
      source_alias: "huge", data_category: "incident", disclosed_field: "failure-summary",
      sensitivity: "internal", summary: "x".repeat(4_097),
    }],
  }), BoundedContextError);
  assert.throws(() => createBoundedContext({
    ...context,
    redacted_excerpts: [{ ...context.redacted_excerpts[0], excerpt: "tampered after approval" }],
  }), BoundedContextError);
  assert.throws(() => createBoundedContext({
    ...context,
    redacted_excerpts: [{ ...context.redacted_excerpts[0], approved: true }],
  }), BoundedContextError);
  assert.throws(() => createBoundedContext({
    task_contract: contract,
    summaries: [{
      source_alias: "issue-summary", data_category: "incident", disclosed_field: "failure-summary",
      sensitivity: "internal", summary: "unapproved",
    }],
    redacted_excerpts: [],
  }), BoundedContextError);
});

test("Codex invokes native skills, propagates cancellation, and never upgrades unverified success", async () => {
  const calls: string[] = [];
  const runtime: HostRuntime = {
    async discover() { return []; },
    async invokeNative(request) { calls.push(`invoke:${request.skill_id}:${request.contract.route_id}`); return { accepted: true, execution_id: "exec-1" }; },
    async cancel(executionId) { calls.push(`cancel:${executionId}`); return { cancelled: true }; },
    async collect() {
      return { status: "succeeded", summary: "Host claimed success", artifacts: [], evidence: [], verification: [] };
    },
    async sessionSources() { return []; },
  };
  const adapter = createCodexHostAdapter({ host_version: "1.4.0", runtime });
  const context = createBoundedContext({ task_contract: contract, summaries: [], redacted_excerpts: [] });
  const handle = await adapter.invoke(provider(), contract, context);
  assert.equal(handle.status, "running");
  const result = await adapter.collect(handle);
  assert.deepEqual(result, {
    status: "partial",
    provider_id: "gstack:investigate",
    route_id: routeId,
    summary: "Host claimed success",
    artifacts: [],
    evidence: [],
    verification: [],
    error: { code: "UNVERIFIED_SUCCESS", retryable: false },
  } satisfies ProviderResult);
  assert.deepEqual(await adapter.cancel(handle), { cancelled: false, reason: "NOT_ACTIVE" });
  const cancellable = await adapter.invoke(provider(), contract, context);
  assert.deepEqual(await adapter.cancel(cancellable), { cancelled: true, reason: null });
  assert.equal((await adapter.collect(cancellable)).status, "cancelled");
  assert.deepEqual(calls, [
    `invoke:gstack:investigate:${routeId}`,
    `invoke:gstack:investigate:${routeId}`,
    "cancel:exec-1",
  ]);
});

test("host adapters bind bounded context to the exact contract and enforce provider sensitivity", async () => {
  let invoked = 0;
  const runtime: HostRuntime = {
    async discover() { return []; },
    async invokeNative() { invoked += 1; return { accepted: true, execution_id: "exec" }; },
    async sessionSources() { return []; },
  };
  const adapter = createCodexHostAdapter({ host_version: "1.4.0", runtime });
  const mismatched = createBoundedContext({
    task_contract: { ...contract, request_digest: digest("f") }, summaries: [], redacted_excerpts: [],
  });
  await assert.rejects(adapter.invoke(provider(), contract, mismatched), { code: "CONTRACT_MISMATCH" });

  const internalDisclosure = {
    summaries: [{
      source_alias: "internal", data_category: "incident", disclosed_field: "failure-summary",
      sensitivity: "internal" as const, summary: "bounded",
    }],
    redacted_excerpts: [],
  };
  const internalApproval: EgressApproval = {
    ...approvedContext().approval,
    source_aliases: ["internal"],
    data_categories: ["incident"],
    disclosed_fields: ["failure-summary"],
    effective_sensitivity: "internal",
    content_digest: boundedContextContentDigest(internalDisclosure),
  };
  const internalContract = { ...contract, egress_approvals: [internalApproval] };
  const internal = createBoundedContext({ task_contract: internalContract, ...internalDisclosure });
  await assert.rejects(adapter.invoke({
    ...provider(),
    context_policy: { ...provider().context_policy, maximum_sensitivity: "public" },
  }, internalContract, internal), { code: "CONTEXT_POLICY_VIOLATION" });
  assert.equal(invoked, 0);
});

test("provider egress is denied before runtime unless exact, current, and authenticated", async () => {
  let invoked = 0;
  let receivedApprovalProvider: string | undefined;
  const runtime: HostRuntime = {
    async discover() { return []; },
    async invokeNative(request) {
      invoked += 1;
      receivedApprovalProvider = request.contract.egress_approvals[0]?.provider_id;
      return { accepted: true, execution_id: "must-not-run" };
    },
    async sessionSources() { return []; },
  };
  const now = () => new Date("2026-08-10T12:00:00Z");
  const valid = approvedContext();

  await assert.rejects(
    createCodexHostAdapter({ host_version: "1.4.0", runtime, now }).invoke(provider(), valid.contract, valid.context),
    { code: "EGRESS_APPROVAL_UNTRUSTED" },
  );
  await assert.rejects(
    createCodexHostAdapter({ host_version: "1.4.0", runtime, now, verify_egress_approval: async () => false })
      .invoke(provider(), valid.contract, valid.context),
    { code: "EGRESS_APPROVAL_UNTRUSTED" },
  );

  for (const mutated of [
    approvedContext({ route_id: "01915b8c-7f2d-7a51-a9c0-1d4cb73b10ad" }),
    approvedContext({ provider_id: "gstack:review" }),
    approvedContext({ destination_id: "cursor" }),
    approvedContext({ source_aliases: ["log-excerpt", "issue-summary"] }),
    approvedContext({ data_categories: ["logs"] }),
    approvedContext({ disclosed_fields: ["failure-summary"] }),
    approvedContext({ effective_sensitivity: "internal" }),
    approvedContext({ content_digest: digest("f") }),
  ]) {
    await assert.rejects(
      createCodexHostAdapter({ host_version: "1.4.0", runtime, now, verify_egress_approval: async () => true })
        .invoke(provider(), mutated.contract, mutated.context),
      { code: "EGRESS_APPROVAL_MISMATCH" },
    );
  }
  const stale = approvedContext({ expires_at: "2026-08-10T12:00:00Z" });
  await assert.rejects(
    createCodexHostAdapter({ host_version: "1.4.0", runtime, now, verify_egress_approval: async () => true })
      .invoke(provider(), stale.contract, stale.context),
    { code: "EGRESS_APPROVAL_EXPIRED" },
  );
  const duplicateContract = { ...valid.contract, egress_approvals: [valid.approval, { ...valid.approval, approval_id: "01915b8c-7f2d-7a51-a9c0-1d4cb73b10ae" }] };
  const duplicateContext = createBoundedContext({ ...valid.context, task_contract: duplicateContract });
  await assert.rejects(
    createCodexHostAdapter({ host_version: "1.4.0", runtime, now, verify_egress_approval: async () => true })
      .invoke(provider(), duplicateContract, duplicateContext),
    { code: "EGRESS_APPROVAL_AMBIGUOUS" },
  );
  assert.equal(invoked, 0);

  const handle = await createCodexHostAdapter({
    host_version: "1.4.0", runtime, now,
    verify_egress_approval: async (approval) => {
      valid.approval.provider_id = "attacker:mutated-after-validation";
      return approval.approval_id === approvalId;
    },
  }).invoke(provider(), valid.contract, valid.context);
  assert.equal(handle.status, "running");
  assert.equal(invoked, 1);
  assert.equal(receivedApprovalProvider, provider().id);
});

test("prompt and manual invocations require acknowledgement instead of reporting success", async () => {
  const unacknowledged: HostRuntime = {
    async discover() { return []; },
    async handoffPrompt() { return { acknowledged: false }; },
    async collect() { throw new Error("must not collect an unacknowledged handoff"); },
    async sessionSources() { return []; },
  };
  const adapter = createClaudeCodeHostAdapter({ host_version: "1.3.0", runtime: unacknowledged });
  const context = createBoundedContext({ task_contract: contract, summaries: [], redacted_excerpts: [] });
  const promptHandle = await adapter.invoke(provider("prompt-handoff"), contract, context);
  assert.equal(promptHandle.status, "handoff-required");
  assert.equal((await adapter.collect(promptHandle)).status, "handoff-required");

  const manualHandle = await adapter.invoke(provider("manual"), contract, context);
  assert.equal(manualHandle.status, "handoff-required");
  assert.equal((await adapter.collect(manualHandle)).error.code, "HANDOFF_REQUIRED");
});

test("Cursor degrades native invocation to acknowledged prompt handoff and discovers Markdown sessions", async () => {
  const prompts: string[] = [];
  const runtime: HostRuntime = {
    async discover() { return []; },
    async handoffPrompt(request) { prompts.push(request.prompt); return { acknowledged: true, execution_id: "cursor-handoff" }; },
    async collect() { return { status: "succeeded", summary: "Verified", artifacts: [], evidence: [digest("c")], verification: [{ code: "completed", passed: true }] }; },
    async sessionSources() {
      return [
        { source: "cursor", source_alias: "cursor-export", format: "markdown", format_version: "1", uri_alias: "selected-export" },
        { source: "cursor", source_alias: "cursor-db", format: "sqlite", format_version: "unknown", uri_alias: "local-db" },
      ];
    },
  };
  const adapter = createCursorHostAdapter({ host_version: "0.48.0", runtime });
  const context = createBoundedContext({ task_contract: contract, summaries: [], redacted_excerpts: [] });
  const handle = await adapter.invoke(provider(), contract, context);
  assert.equal(handle.mode, "prompt-handoff");
  assert.equal(handle.status, "running");
  assert.match(prompts[0] ?? "", /route_id.*01915b8c/i);
  assert.equal((await adapter.collect(handle)).status, "succeeded");
  assert.deepEqual(await adapter.sessionSources({ roots: ["selected-export"], from: "2026-08-01", through: "2026-08-10" }), [
    { source: "cursor", source_alias: "cursor-export", format: "markdown", format_version: "1", uri_alias: "selected-export", health: "healthy" },
  ]);
});

test("host compatibility is exact and unsupported versions remain discoverable but incompatible", async () => {
  const runtime: HostRuntime = {
    async discover() { return [{ source: "garrytan/gstack", skill_id: "gstack:investigate", version: "1.2.0", install_scope: "user", path_alias: "gstack", digest: digest("d") }]; },
    async sessionSources() { return []; },
  };
  const adapter = createCodexHostAdapter({ host_version: "9.0.0", runtime });
  assert.equal(adapter.health(), "incompatible");
  assert.equal((await adapter.discover()).length, 1);
  await assert.rejects(adapter.invoke(
    provider(),
    contract,
    createBoundedContext({ task_contract: contract, summaries: [], redacted_excerpts: [] }),
  ), { code: "INCOMPATIBLE_HOST_VERSION" });
});

test("host lifecycle observation is content-free and follows invoke, collect, and cancel terminals", async () => {
  const events: SkillEvent[] = [];
  let tick = 0;
  const now = () => new Date(1_754_827_200_000 + (tick++ * 25));
  const runtime: HostRuntime = {
    async discover() { return []; },
    async invokeNative() { return { accepted: true, execution_id: `exec-${tick}` }; },
    async collect() {
      return { status: "succeeded", summary: "private result summary", artifacts: [], evidence: [], verification: [{ code: "verified", passed: true }] };
    },
    async cancel() { return { cancelled: true }; },
    async sessionSources() { return []; },
  };
  const adapter = createCodexHostAdapter({
    host_version: "1.4.0",
    runtime,
    now,
    lifecycle_observer: async (event) => { events.push(event); },
  });
  const empty = createBoundedContext({ task_contract: contract, summaries: [], redacted_excerpts: [] });
  const completed = await adapter.invoke(provider(), contract, empty);
  assert.equal((await adapter.collect(completed)).status, "succeeded");
  const cancelled = await adapter.invoke(provider(), contract, empty);
  assert.deepEqual(await adapter.cancel(cancelled), { cancelled: true, reason: null });

  assert.deepEqual(events.map((event) => [event.event_type, event.status]), [
    ["invoked", null],
    ["completed", "succeeded"],
    ["invoked", null],
    ["cancelled", "cancelled"],
  ]);
  assert.ok(events.every((event) => event.observation_source === "host-adapter" && event.provider === provider().id));
  assert.doesNotMatch(JSON.stringify(events), /private result summary|Find the root cause|REDACTED/);
});

test("observer failure never affects execution and runtime invocation failure is observed", async () => {
  const eventStatuses: Array<[SkillEvent["event_type"], SkillEvent["status"]]> = [];
  const failedRuntime: HostRuntime = {
    async discover() { return []; },
    async invokeNative() { throw Object.assign(new Error("host down"), { code: "HOST_DOWN" }); },
    async sessionSources() { return []; },
  };
  const adapter = createCodexHostAdapter({
    host_version: "1.4.0",
    runtime: failedRuntime,
    lifecycle_observer: async (event) => { eventStatuses.push([event.event_type, event.status]); },
  });
  const empty = createBoundedContext({ task_contract: contract, summaries: [], redacted_excerpts: [] });
  await assert.rejects(adapter.invoke(provider(), contract, empty), { code: "HOST_DOWN" });
  assert.deepEqual(eventStatuses, [["invoked", null], ["completed", "failed"]]);

  const healthyRuntime: HostRuntime = {
    async discover() { return []; },
    async invokeNative() { return { accepted: true, execution_id: "exec-observer-fails" }; },
    async collect() {
      return { status: "succeeded", summary: "done", artifacts: [], evidence: [], verification: [{ code: "verified", passed: true }] };
    },
    async sessionSources() { return []; },
  };
  const observerFails = createCodexHostAdapter({
    host_version: "1.4.0",
    runtime: healthyRuntime,
    lifecycle_observer: async () => { throw new Error("observer storage unavailable"); },
  });
  const handle = await observerFails.invoke(provider(), contract, empty);
  assert.equal(handle.status, "running");
  assert.equal((await observerFails.collect(handle)).status, "succeeded");
});

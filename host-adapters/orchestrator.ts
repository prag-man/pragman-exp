import type { ProviderDefinition, ProviderSideEffect } from "../packages/provider-registry/src/index.ts";
import type { SideEffect, TaskContract } from "../packages/router/src/index.ts";
import {
  createBoundedContext,
  type AdapterTaskContract,
  type BoundedContext,
  type ContextSummary,
  type HostAdapter,
  type InvocationHandle,
  type ProviderResult,
  type RedactedExcerpt,
} from "./types.ts";

export interface ProviderContextSelection {
  summaries: ContextSummary[];
  redacted_excerpts: RedactedExcerpt[];
}

export interface ProviderHandoff {
  provider: ProviderDefinition;
  contract: AdapterTaskContract;
  context: BoundedContext;
}

export interface RouteExecutionInput {
  contract: TaskContract;
  providers: readonly ProviderDefinition[];
  adapter: HostAdapter;
  contexts?: Readonly<Record<string, ProviderContextSelection | undefined>>;
  signal?: AbortSignal;
}

export type RouteExecutionStepStatus = ProviderResult["status"] | "pending" | "skipped";

export interface RouteExecutionStep {
  provider_id: string;
  capabilities: string[];
  status: RouteExecutionStepStatus;
  result: ProviderResult | null;
  outcome_code: string | null;
}

export interface RouteExecutionResult {
  route_id: string;
  status: ProviderResult["status"];
  completed_capabilities: string[];
  remaining_capabilities: string[];
  steps: RouteExecutionStep[];
  error: { code: string | null; retryable: boolean };
}

export class RouteExecutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RouteExecutionError";
  }
}

const SIDE_EFFECT_PROJECTION: Record<SideEffect, ProviderSideEffect | null> = {
  "project-file-write": "project-file-write",
  "workspace-file-write": null,
  "credential-use": "credential-access",
  "destructive-action": "destructive",
  "paid-external-action": null,
  "production-data-write": "production-data-write",
  "external-message": "external-message",
  "issue-write": "issue-write",
  "pull-request-write": "pull-request-write",
  purchase: "purchase",
  "external-account-mutation": "external-account-mutation",
  deployment: "deploy",
  "live-data-write": null,
};

function executionError(code: string, message: string): never {
  throw new RouteExecutionError(code, message);
}

function providerMap(definitions: readonly ProviderDefinition[]): Map<string, ProviderDefinition> {
  const result = new Map<string, ProviderDefinition>();
  for (const definition of definitions) {
    if (result.has(definition.id)) executionError("DUPLICATE_PROVIDER_DEFINITION", `Duplicate provider definition: ${definition.id}`);
    result.set(definition.id, definition);
  }
  return result;
}

function validateContract(contract: TaskContract): void {
  if (contract.schema_version !== 1 || !Number.isSafeInteger(contract.router_depth)
    || contract.router_depth < 0 || contract.router_depth > 3) {
    executionError("INVALID_ROUTE_CONTRACT", "Route contract has an invalid schema or router depth");
  }
  if (contract.providers.length !== contract.provider_assignments.length
    || contract.providers.some((providerId, index) => contract.provider_assignments[index]?.provider_id !== providerId)
    || new Set(contract.providers).size !== contract.providers.length) {
    executionError("INVALID_PROVIDER_ASSIGNMENTS", "Provider assignments must exactly follow routed provider order");
  }
  const required = new Set(contract.capabilities);
  const supplied = new Set<string>();
  for (const assignment of contract.provider_assignments) {
    if (assignment.capabilities.length === 0 || new Set(assignment.capabilities).size !== assignment.capabilities.length
      || assignment.capabilities.some((capability) => !required.has(capability))) {
      executionError("INVALID_PROVIDER_ASSIGNMENTS", "Provider assignments contain invalid capabilities");
    }
    for (const capability of assignment.capabilities) supplied.add(capability);
  }
  if (required.size !== supplied.size || [...required].some((capability) => !supplied.has(capability))) {
    executionError("INVALID_PROVIDER_ASSIGNMENTS", "Provider assignments do not cover the routed capabilities");
  }
  if (contract.provider_sequence_policy === "continue-independent" && contract.execution_mode !== "independent-fanout") {
    executionError("INVALID_SEQUENCE_POLICY", "continue-independent requires independent fanout");
  }
  if (contract.provider_sequence_policy === "fallback" && contract.execution_mode !== "serial") {
    executionError("INVALID_SEQUENCE_POLICY", "fallback requires serial execution");
  }
}

function projectedSideEffects(sideEffects: readonly SideEffect[]): ProviderSideEffect[] {
  return sideEffects.map((sideEffect) => {
    const projected = SIDE_EFFECT_PROJECTION[sideEffect];
    if (projected === null) executionError(
      "UNSUPPORTED_SIDE_EFFECT_PROJECTION",
      `No provider-side effect mapping exists for ${sideEffect}`,
    );
    return projected;
  });
}

export function projectProviderHandoff(
  contract: TaskContract,
  selectedProvider: ProviderDefinition,
  selection: ProviderContextSelection,
): ProviderHandoff {
  validateContract(contract);
  const assignment = contract.provider_assignments.find((entry) => entry.provider_id === selectedProvider.id);
  if (!assignment) executionError("PROVIDER_NOT_SELECTED", "Provider is not selected by the routed contract");
  const adapterContract: AdapterTaskContract = {
    schema_version: 1,
    route_id: contract.route_id,
    router_depth: contract.router_depth,
    request_digest: contract.request_digest,
    outcome: contract.outcome,
    capabilities: [...assignment.capabilities],
    providers: [selectedProvider.id],
    provider_assignments: [{ provider_id: selectedProvider.id, capabilities: [...assignment.capabilities] }],
    allowed_side_effects: projectedSideEffects(contract.allowed_side_effects),
    effective_sensitivity: contract.effective_sensitivity,
    egress_approvals: contract.egress_approvals
      .filter((approval) => approval.provider_id === selectedProvider.id)
      .map((approval) => structuredClone(approval)),
  };
  const context = createBoundedContext({
    task_contract: adapterContract,
    summaries: structuredClone(selection.summaries),
    redacted_excerpts: structuredClone(selection.redacted_excerpts),
  });
  return { provider: structuredClone(selectedProvider), contract: adapterContract, context };
}

function failureResult(providerId: string, routeId: string, error: unknown): ProviderResult {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "ADAPTER_INVOCATION_FAILED";
  return {
    status: "failed",
    provider_id: providerId,
    route_id: routeId,
    summary: "Provider invocation failed before a verified result was collected.",
    artifacts: [],
    evidence: [],
    verification: [],
    error: { code, retryable: false },
  };
}

function normalizeCollectedResult(handle: InvocationHandle, collected: ProviderResult): ProviderResult {
  if (collected.provider_id !== handle.provider_id || collected.route_id !== handle.route_id) {
    return failureResult(handle.provider_id, handle.route_id, { code: "PROVIDER_RESULT_IDENTITY_MISMATCH" });
  }
  if (collected.status === "succeeded"
    && (collected.verification.length === 0 || collected.verification.some((entry) => entry.passed !== true))) {
    return {
      ...structuredClone(collected),
      status: "partial",
      error: { code: "UNVERIFIED_SUCCESS", retryable: false },
    };
  }
  return structuredClone(collected);
}

function skippedStep(step: RouteExecutionStep, outcomeCode: string): void {
  step.status = "skipped";
  step.result = null;
  step.outcome_code = outcomeCode;
}

export class RouteExecution {
  readonly #input: RouteExecutionInput;
  readonly #providers: Map<string, ProviderDefinition>;
  readonly #steps: RouteExecutionStep[];
  readonly #active = new Map<string, InvocationHandle>();
  #runStarted = false;
  #cancelled = false;
  #sequenceStopped = false;
  #cancelPromise: Promise<void> | null = null;

  constructor(input: RouteExecutionInput) {
    validateContract(input.contract);
    this.#input = input;
    this.#providers = providerMap(input.providers);
    const selected = new Set(input.contract.providers);
    const unknownContexts = Object.keys(input.contexts ?? {}).filter((providerId) => !selected.has(providerId));
    if (unknownContexts.length > 0) executionError("UNSELECTED_CONTEXT", "Context was supplied for an unselected provider");
    for (const providerId of input.contract.providers) {
      if (!this.#providers.has(providerId)) executionError("MISSING_PROVIDER_DEFINITION", `Missing provider definition: ${providerId}`);
    }
    this.#steps = input.contract.provider_assignments.map((assignment) => ({
      provider_id: assignment.provider_id,
      capabilities: [...assignment.capabilities],
      status: "pending",
      result: null,
      outcome_code: null,
    }));
  }

  async #cancelActive(): Promise<void> {
    for (const providerId of this.#input.contract.providers) {
      const handle = this.#active.get(providerId);
      if (!handle) continue;
      try { await this.#input.adapter.cancel(handle); } catch { /* Cancellation remains fail-closed. */ }
    }
  }

  async cancel(): Promise<void> {
    this.#cancelled = true;
    this.#cancelPromise ??= this.#cancelActive();
    await this.#cancelPromise;
  }

  async #runStep(step: RouteExecutionStep): Promise<RouteExecutionStep> {
    if (this.#cancelled || this.#input.signal?.aborted) {
      this.#cancelled = true;
      skippedStep(step, "cancelled-before-invoke");
      return step;
    }
    const definition = this.#providers.get(step.provider_id)!;
    try {
      const selection = this.#input.contexts?.[step.provider_id] ?? { summaries: [], redacted_excerpts: [] };
      const handoff = projectProviderHandoff(this.#input.contract, definition, selection);
      const handle = await this.#input.adapter.invoke(handoff.provider, handoff.contract, handoff.context);
      this.#active.set(step.provider_id, handle);
      if (this.#cancelled || this.#sequenceStopped || this.#input.signal?.aborted) {
        if (this.#input.signal?.aborted) this.#cancelled = true;
        try { await this.#input.adapter.cancel(handle); } catch { /* Execution remains fail-closed. */ }
      }
      const collected = normalizeCollectedResult(handle, await this.#input.adapter.collect(handle));
      step.status = collected.status;
      step.result = collected;
      step.outcome_code = collected.error.code ?? "provider-succeeded";
      return step;
    } catch (error) {
      const failed = failureResult(step.provider_id, this.#input.contract.route_id, error);
      step.status = "failed";
      step.result = failed;
      step.outcome_code = failed.error.code;
      return step;
    } finally {
      this.#active.delete(step.provider_id);
    }
  }

  #aggregate(): RouteExecutionResult {
    const completed = new Set<string>();
    for (const step of this.#steps) if (step.status === "succeeded") {
      for (const capability of step.capabilities) completed.add(capability);
    }
    const completedCapabilities = this.#input.contract.capabilities.filter((capability) => completed.has(capability));
    const remainingCapabilities = this.#input.contract.capabilities.filter((capability) => !completed.has(capability));
    const attempted = this.#steps.filter((step) => step.result !== null);
    let status: ProviderResult["status"];
    let code: string | null;
    if (this.#cancelled || this.#input.signal?.aborted) {
      status = "cancelled"; code = "ROUTE_CANCELLED";
    } else if (attempted.length === 0) {
      status = "partial"; code = "NO_PROVIDER_EXECUTION";
    } else if (remainingCapabilities.length === 0) {
      status = "succeeded"; code = null;
    } else if (attempted.some((step) => step.status === "failed")) {
      status = "failed"; code = attempted.find((step) => step.status === "failed")?.result?.error.code ?? "ROUTE_FAILED";
    } else if (attempted.some((step) => step.status === "handoff-required")) {
      status = "handoff-required"; code = "HANDOFF_REQUIRED";
    } else if (attempted.some((step) => step.status === "cancelled")) {
      status = "cancelled"; code = "ROUTE_CANCELLED";
    } else {
      status = "partial"; code = attempted.find((step) => step.status === "partial")?.result?.error.code ?? "ROUTE_INCOMPLETE";
    }
    return {
      route_id: this.#input.contract.route_id,
      status,
      completed_capabilities: completedCapabilities,
      remaining_capabilities: remainingCapabilities,
      steps: structuredClone(this.#steps),
      error: { code, retryable: attempted.some((step) => step.result?.error.retryable === true) },
    };
  }

  async run(): Promise<RouteExecutionResult> {
    if (this.#runStarted) executionError("EXECUTION_ALREADY_STARTED", "A route execution can run only once");
    this.#runStarted = true;
    const abort = () => { void this.cancel(); };
    this.#input.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (this.#input.signal?.aborted) await this.cancel();
      if (this.#steps.length === 0) return this.#aggregate();
      if (this.#input.contract.execution_mode === "independent-fanout") {
        const stopOnFailure = this.#input.contract.provider_sequence_policy === "stop";
        await Promise.all(this.#steps.map(async (step) => {
          const finished = await this.#runStep(step);
          if (stopOnFailure && finished.status !== "succeeded") {
            this.#sequenceStopped = true;
            await this.#cancelActive();
          }
        }));
        return this.#aggregate();
      }
      const completed = new Set<string>();
      for (const step of this.#steps) {
        if (this.#cancelled) {
          skippedStep(step, "cancelled-before-invoke");
          continue;
        }
        if (this.#input.contract.provider_sequence_policy === "fallback"
          && step.capabilities.every((capability) => completed.has(capability))) {
          skippedStep(step, "capability-already-satisfied");
          continue;
        }
        const finished = await this.#runStep(step);
        if (finished.status === "succeeded") for (const capability of finished.capabilities) completed.add(capability);
        if (this.#input.contract.provider_sequence_policy === "stop" && finished.status !== "succeeded") {
          for (const remaining of this.#steps.slice(this.#steps.indexOf(step) + 1)) skippedStep(remaining, "sequence-stopped");
          break;
        }
      }
      if (this.#cancelPromise) await this.#cancelPromise;
      return this.#aggregate();
    } finally {
      this.#input.signal?.removeEventListener("abort", abort);
    }
  }
}

export function createRouteExecution(input: RouteExecutionInput): RouteExecution {
  return new RouteExecution(input);
}

export async function executeReadyRoute(input: RouteExecutionInput): Promise<RouteExecutionResult> {
  return createRouteExecution(input).run();
}

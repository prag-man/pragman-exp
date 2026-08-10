import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { satisfiesVersionRange, type HealthState, type HostId, type ProviderDefinition } from "../packages/provider-registry/src/index.ts";
import type { SkillEvent } from "../packages/events/src/types.ts";
import {
  createBoundedContext,
  providerDefinitionDigest,
  providerHandoffContentDigest,
  type AdapterTaskContract,
  type BoundedContext,
  type CancellationResult,
  type EgressApproval,
  type EgressApprovalVerifier,
  type HostAdapter,
  type HostCapability,
  type HostRuntime,
  type InvocationHandle,
  type ProviderLifecycleObserver,
  type ProviderResult,
  type RuntimeProviderResult,
  type SessionSource,
  type SessionSourceSelection,
} from "./types.ts";

export interface AdapterCompatibility {
  host_version: string;
  session_formats: Record<string, string[]>;
  native_skill_invocation: boolean;
  prompt_handoff: boolean;
}

export interface CreateHostAdapterOptions {
  host_version: string;
  runtime: HostRuntime;
  verify_egress_approval?: EgressApprovalVerifier;
  lifecycle_observer?: ProviderLifecycleObserver;
  now?: () => Date;
}

interface ProviderObservationState {
  provider: ProviderDefinition;
  started_at_ms: number;
  source_aliases: string[];
  terminal_observed: boolean;
}

const SENSITIVITY_RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 } as const;

function uuidV7(): string {
  const bytes = randomBytes(16);
  let milliseconds = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = milliseconds & 0xff;
    milliseconds = Math.floor(milliseconds / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function boundedSummary(value: string): string {
  return value.length <= 1_000 ? value : `${value.slice(0, 997)}...`;
}

function enforceContextPolicy(provider: ProviderDefinition, context: BoundedContext): void {
  const classes = new Set(provider.context_policy.accepted_classes);
  const sensitivities = [
    context.task_contract.effective_sensitivity,
    ...context.summaries.map((entry) => entry.sensitivity),
    ...context.redacted_excerpts.map((entry) => entry.sensitivity),
  ];
  const exceedsSensitivity = sensitivities.some((sensitivity) =>
    SENSITIVITY_RANK[sensitivity] > SENSITIVITY_RANK[provider.context_policy.maximum_sensitivity]);
  if (!classes.has("task-contract")
    || (context.summaries.length > 0 && !classes.has("context-summary"))
    || (context.redacted_excerpts.length > 0
      && (!classes.has("redacted-excerpt") || !provider.context_policy.accepts_redacted_excerpts))
    || exceedsSensitivity) {
    throw Object.assign(new Error("Bounded context violates the provider policy"), { code: "CONTEXT_POLICY_VIOLATION" });
  }
}

function enforceProviderBinding(provider: ProviderDefinition, contract: AdapterTaskContract): void {
  if (!contract.providers.includes(provider.id)) {
    throw Object.assign(new Error("Provider was not selected by the routed contract"), { code: "PROVIDER_NOT_SELECTED" });
  }
  const assignment = contract.provider_assignments.find((entry) => entry.provider_id === provider.id);
  if (!assignment) {
    throw Object.assign(new Error("Provider assignment is missing from the routed contract"), { code: "PROVIDER_CAPABILITY_MISMATCH" });
  }
  const providerCapabilities = new Set(provider.capabilities);
  if (assignment.capabilities.some((capability) => !providerCapabilities.has(capability))) {
    throw Object.assign(new Error("Provider does not cover its assigned capabilities"), { code: "PROVIDER_CAPABILITY_MISMATCH" });
  }
  const allowedSideEffects = new Set<string>(contract.allowed_side_effects);
  if (provider.side_effects.some((sideEffect) => !allowedSideEffects.has(sideEffect))) {
    throw Object.assign(new Error("Provider declares a side effect outside the routed allowance"), { code: "PROVIDER_SIDE_EFFECT_MISMATCH" });
  }
}

function disclosureAliases(context: BoundedContext): string[] {
  return [...new Set([
    ...context.summaries.map((entry) => entry.source_alias),
    ...context.redacted_excerpts.map((entry) => entry.source_alias),
  ])].sort();
}

function disclosureCategories(context: BoundedContext): string[] {
  return [...new Set([
    ...context.summaries.map((entry) => entry.data_category),
    ...context.redacted_excerpts.map((entry) => entry.data_category),
  ])].sort();
}

function disclosedFields(context: BoundedContext): string[] {
  return [...new Set([
    ...context.summaries.map((entry) => entry.disclosed_field),
    ...context.redacted_excerpts.map((entry) => entry.disclosed_field),
  ])].sort();
}

function disclosureSensitivity(contract: AdapterTaskContract, context: BoundedContext): EgressApproval["effective_sensitivity"] {
  const values = [
    contract.effective_sensitivity,
    ...context.summaries.map((entry) => entry.sensitivity),
    ...context.redacted_excerpts.map((entry) => entry.sensitivity),
  ];
  return values.reduce<EgressApproval["effective_sensitivity"]>(
    (highest, value) => SENSITIVITY_RANK[value] > SENSITIVITY_RANK[highest] ? value : highest,
    "public",
  );
}

function approvalAliases(context: BoundedContext): string[] {
  return [...new Set(["task-contract", ...disclosureAliases(context)])].sort();
}

function approvalCategories(context: BoundedContext): string[] {
  return [...new Set(["route-request", ...disclosureCategories(context)])].sort();
}

function approvalFields(context: BoundedContext): string[] {
  return [...new Set(["effective-sensitivity", "outcome", "request-digest", ...disclosedFields(context)])].sort();
}

function approvalError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function normalizeRuntimeResult(handle: InvocationHandle, value: RuntimeProviderResult): ProviderResult {
  const base = {
    provider_id: handle.provider_id,
    route_id: handle.route_id,
    summary: boundedSummary(value.summary),
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
    evidence: Array.isArray(value.evidence) ? value.evidence : [],
    verification: Array.isArray(value.verification) ? value.verification : [],
  };
  if (value.status === "succeeded") {
    const verified = base.verification.length > 0 && base.verification.every((entry) => entry.passed === true);
    return verified
      ? { ...base, status: "succeeded", error: { code: null, retryable: false } }
      : { ...base, status: "partial", error: { code: "UNVERIFIED_SUCCESS", retryable: false } };
  }
  if (value.status === "running") return { ...base, status: "partial", error: { code: "RESULT_NOT_READY", retryable: true } };
  return {
    ...base,
    status: value.status,
    error: value.error ?? { code: value.status === "cancelled" ? "CANCELLED" : value.status === "partial" ? "PARTIAL_RESULT" : "PROVIDER_FAILED", retryable: false },
  };
}

function handoffResult(handle: InvocationHandle): ProviderResult {
  return {
    status: "handoff-required",
    provider_id: handle.provider_id,
    route_id: handle.route_id,
    summary: "Provider execution requires a user-visible handoff.",
    artifacts: [], evidence: [], verification: [],
    error: { code: "HANDOFF_REQUIRED", retryable: false },
  };
}

export class ConcreteHostAdapter implements HostAdapter {
  readonly host: HostId;
  readonly host_version: string;
  readonly #runtime: HostRuntime;
  readonly #compatibility: AdapterCompatibility;
  readonly #handles = new Map<string, InvocationHandle>();
  readonly #observations = new Map<string, ProviderObservationState>();
  readonly #verifyEgressApproval: EgressApprovalVerifier | undefined;
  readonly #lifecycleObserver: ProviderLifecycleObserver | undefined;
  readonly #now: () => Date;

  constructor(
    host: HostId,
    host_version: string,
    runtime: HostRuntime,
    compatibility: AdapterCompatibility,
    options: Pick<CreateHostAdapterOptions, "verify_egress_approval" | "lifecycle_observer" | "now"> = {},
  ) {
    this.host = host;
    this.host_version = host_version;
    this.#runtime = runtime;
    this.#compatibility = compatibility;
    this.#verifyEgressApproval = options.verify_egress_approval;
    this.#lifecycleObserver = options.lifecycle_observer;
    this.#now = options.now ?? (() => new Date());
  }

  async #authorizeDisclosure(provider: ProviderDefinition, contract: AdapterTaskContract, context: BoundedContext): Promise<void> {
    if (contract.egress_approvals.length === 0) {
      throw approvalError("EGRESS_APPROVAL_REQUIRED", "External task-contract disclosure requires egress approval");
    }
    const aliases = approvalAliases(context);
    const categories = approvalCategories(context);
    const fields = approvalFields(context);
    const expectedSensitivity = disclosureSensitivity(contract, context);
    const now = this.#now().getTime();
    const destination = { destination: "host-model" as const, destination_id: this.host };
    const contentDigest = providerHandoffContentDigest(provider, contract, context, destination);
    const matching = contract.egress_approvals.filter((approval) => approval.route_id === contract.route_id
      && approval.provider_id === provider.id
      && approval.destination === destination.destination
      && approval.destination_id === destination.destination_id
      && isDeepStrictEqual(approval.source_aliases, aliases)
      && isDeepStrictEqual(approval.data_categories, categories)
      && isDeepStrictEqual(approval.disclosed_fields, fields)
      && approval.effective_sensitivity === expectedSensitivity
      && approval.content_digest === contentDigest);
    if (matching.length === 0) {
      throw approvalError("EGRESS_APPROVAL_MISMATCH", "Egress approval does not match the exact provider disclosure");
    }
    const active = matching.filter((approval) => Date.parse(approval.approved_at) <= now && Date.parse(approval.expires_at) > now);
    if (active.length === 0) {
      throw approvalError("EGRESS_APPROVAL_EXPIRED", "Egress approval is not currently valid");
    }
    if (active.length !== 1) {
      throw approvalError("EGRESS_APPROVAL_AMBIGUOUS", "Multiple active egress approvals match the provider disclosure");
    }
    const approval = active[0]!;
    if (!this.#verifyEgressApproval) {
      throw approvalError("EGRESS_APPROVAL_UNTRUSTED", "Egress approval has no trusted verifier");
    }
    let trusted = false;
    try {
      trusted = await this.#verifyEgressApproval(structuredClone(approval));
    } catch {
      trusted = false;
    }
    if (!trusted) throw approvalError("EGRESS_APPROVAL_UNTRUSTED", "Egress approval was not authenticated");
  }

  async #observe(
    handle: Pick<InvocationHandle, "invocation_id" | "route_id" | "provider_id">,
    state: ProviderObservationState,
    eventType: "invoked" | "completed" | "cancelled",
    status: SkillEvent["status"],
    outcomeCode: string | null,
  ): Promise<void> {
    if (!this.#lifecycleObserver || (eventType !== "invoked" && state.terminal_observed)) return;
    if (eventType !== "invoked") state.terminal_observed = true;
    const now = this.#now();
    const event: SkillEvent = {
      schema_version: 1,
      event_id: uuidV7(),
      invocation_id: handle.invocation_id,
      timestamp: now.toISOString(),
      event_type: eventType,
      skill_id: state.provider.id,
      skill_version: state.provider.source_version,
      skill_digest: providerDefinitionDigest(state.provider),
      skill_type: "capability",
      host: this.host,
      host_version: this.host_version,
      model: "none",
      model_version: "none",
      harness_version: "1",
      invocation_mode: "host",
      session_id: null,
      route_id: handle.route_id,
      eval_id: null,
      case_id: null,
      trial_id: null,
      provider: handle.provider_id,
      ablation_arm: "production",
      trigger_expected: null,
      trigger_actual: true,
      provider_digest: providerDefinitionDigest(state.provider),
      eval_corpus_digest: null,
      trial_policy_digest: null,
      status,
      outcome_code: outcomeCode,
      duration_ms: eventType === "invoked" ? 0 : Math.max(0, now.getTime() - state.started_at_ms),
      tool_calls: 0,
      retries: 0,
      rework_cycles: 0,
      verification_checks: 0,
      verification_passes: 0,
      observation_source: "host-adapter",
      source_aliases: state.source_aliases,
      storage_scope: "local",
      append_only: true,
    };
    try {
      await this.#lifecycleObserver(event);
    } catch {
      // Observation is intentionally best-effort and cannot affect execution.
    } finally {
      if (eventType !== "invoked") this.#observations.delete(handle.invocation_id);
    }
  }

  health(): HealthState {
    return satisfiesVersionRange(this.host_version, this.#compatibility.host_version) ? "healthy" : "incompatible";
  }

  capabilities(): HostCapability[] {
    const result: HostCapability[] = ["discovery", "session-sources"];
    if (this.#compatibility.native_skill_invocation && this.#runtime.invokeNative) result.push("native-skill");
    if (this.#compatibility.prompt_handoff && this.#runtime.handoffPrompt) result.push("prompt-handoff");
    if (this.#runtime.invokeCli) result.push("cli");
    if (this.#runtime.cancel) result.push("cancellation");
    if (this.#runtime.collect) result.push("collection");
    return result;
  }

  discover() {
    return this.#runtime.discover();
  }

  async invoke(provider: ProviderDefinition, contract: AdapterTaskContract, context: BoundedContext): Promise<InvocationHandle> {
    provider = structuredClone(provider);
    if (this.health() !== "healthy") throw Object.assign(new Error("Host version is incompatible"), { code: "INCOMPATIBLE_HOST_VERSION" });
    if (!provider.host_support.includes(this.host)) throw Object.assign(new Error("Provider does not support this host"), { code: "HOST_UNSUPPORTED" });
    const safeContext = createBoundedContext(context);
    if (!isDeepStrictEqual(safeContext.task_contract, contract)) {
      throw Object.assign(new Error("Handoff context does not match its task contract"), { code: "CONTRACT_MISMATCH" });
    }
    const safeContract = safeContext.task_contract;
    enforceProviderBinding(provider, safeContract);
    enforceContextPolicy(provider, safeContext);
    const createHandle = (
      mode: InvocationHandle["mode"],
      status: InvocationHandle["status"],
      executionId: string | null,
      instructions: string[] = [],
      invocationId = uuidV7(),
    ): InvocationHandle => {
      const handle = {
        invocation_id: invocationId, provider_id: provider.id, route_id: safeContract.route_id,
        mode, status, execution_id: executionId, handoff_instructions: instructions,
      };
      this.#handles.set(handle.invocation_id, handle);
      return structuredClone(handle);
    };
    const beginRuntime = async () => {
      const invocationId = uuidV7();
      const state: ProviderObservationState = {
        provider: structuredClone(provider),
        started_at_ms: this.#now().getTime(),
        source_aliases: disclosureAliases(safeContext),
        terminal_observed: false,
      };
      if (this.#lifecycleObserver) this.#observations.set(invocationId, state);
      const identity = { invocation_id: invocationId, provider_id: provider.id, route_id: safeContract.route_id };
      await this.#observe(identity, state, "invoked", null, null);
      return { invocationId, state, identity };
    };
    const failedRuntime = async (runtime: Awaited<ReturnType<typeof beginRuntime>>) => {
      await this.#observe(runtime.identity, runtime.state, "completed", "failed", "provider-invoke-failed");
    };
    const handoffRuntime = async (
      runtime: Awaited<ReturnType<typeof beginRuntime>>,
      mode: InvocationHandle["mode"],
      instructions: string[],
    ) => {
      const handle = createHandle(mode, "handoff-required", null, instructions, runtime.invocationId);
      await this.#observe(runtime.identity, runtime.state, "completed", "handoff-required", "handoff-required");
      return handle;
    };

    if (provider.invoke.kind === "manual") return createHandle("manual", "handoff-required", null, provider.invoke.instructions);
    if (provider.invoke.kind === "cli") {
      if (!this.#runtime.invokeCli) return createHandle("cli", "handoff-required", null, [`Run pragman ${provider.invoke.arguments.join(" ")}`]);
      const observed = await beginRuntime();
      try {
        const result = await this.#runtime.invokeCli({ provider_id: provider.id, executable: provider.invoke.executable, arguments: provider.invoke.arguments, contract: safeContract, context: safeContext });
        return result.accepted && result.execution_id
          ? createHandle("cli", "running", result.execution_id, [], observed.invocationId)
          : handoffRuntime(observed, "cli", [`Run pragman ${provider.invoke.arguments.join(" ")}`]);
      } catch (error) {
        await failedRuntime(observed);
        throw error;
      }
    }
    let observed: Awaited<ReturnType<typeof beginRuntime>> | null = null;
    let authorizedHostDisclosure = false;
    const authorizeHostDisclosure = async () => {
      if (authorizedHostDisclosure) return;
      await this.#authorizeDisclosure(provider, safeContract, safeContext);
      authorizedHostDisclosure = true;
    };
    if (provider.invoke.kind === "native-skill" && this.#compatibility.native_skill_invocation && this.#runtime.invokeNative) {
      await authorizeHostDisclosure();
      observed = await beginRuntime();
      try {
        const result = await this.#runtime.invokeNative({ provider_id: provider.id, skill_id: provider.invoke.skill_id, contract: safeContract, context: safeContext });
        if (result.accepted && result.execution_id) return createHandle("native-skill", "running", result.execution_id, [], observed.invocationId);
      } catch (error) {
        await failedRuntime(observed);
        throw error;
      }
    }
    const prompt = provider.invoke.kind === "prompt-handoff"
      ? provider.invoke.prompt
      : `Invoke ${provider.invoke.skill_id} for route_id ${safeContract.route_id} at router_depth ${safeContract.router_depth}. Return only the declared provider result contract.`;
    if (this.#compatibility.prompt_handoff && this.#runtime.handoffPrompt) {
      await authorizeHostDisclosure();
      observed ??= await beginRuntime();
      try {
        const result = await this.#runtime.handoffPrompt({ provider_id: provider.id, prompt, contract: safeContract, context: safeContext });
        if (result.acknowledged && result.execution_id) return createHandle("prompt-handoff", "running", result.execution_id, [], observed.invocationId);
      } catch (error) {
        await failedRuntime(observed);
        throw error;
      }
    }
    return observed
      ? handoffRuntime(observed, "prompt-handoff", [prompt])
      : createHandle("prompt-handoff", "handoff-required", null, [prompt]);
  }

  async cancel(handle: InvocationHandle): Promise<CancellationResult> {
    const current = this.#handles.get(handle.invocation_id);
    if (!current || current.status !== "running" || !current.execution_id) return { cancelled: false, reason: "NOT_ACTIVE" };
    if (!this.#runtime.cancel) return { cancelled: false, reason: "UNSUPPORTED" };
    const result = await this.#runtime.cancel(current.execution_id);
    if (!result.cancelled) return { cancelled: false, reason: "HOST_REJECTED" };
    current.status = "cancelled";
    const observation = this.#observations.get(current.invocation_id);
    if (observation) await this.#observe(current, observation, "cancelled", "cancelled", "provider-cancelled");
    return { cancelled: true, reason: null };
  }

  async collect(handle: InvocationHandle): Promise<ProviderResult> {
    const current = this.#handles.get(handle.invocation_id);
    if (!current || current.provider_id !== handle.provider_id || current.route_id !== handle.route_id) {
      return { ...handoffResult(handle), status: "failed", summary: "Invocation handle is unknown.", error: { code: "UNKNOWN_HANDLE", retryable: false } };
    }
    if (current.status === "cancelled") return {
      status: "cancelled", provider_id: current.provider_id, route_id: current.route_id, summary: "Provider invocation was cancelled.",
      artifacts: [], evidence: [], verification: [], error: { code: "CANCELLED", retryable: false },
    };
    if (current.status === "handoff-required" || !current.execution_id || !this.#runtime.collect) return handoffResult(current);
    try {
      const runtimeResult = await this.#runtime.collect(current.execution_id);
      const result = normalizeRuntimeResult(current, runtimeResult);
      if (["succeeded", "failed", "cancelled"].includes(runtimeResult.status)) {
        current.status = runtimeResult.status === "cancelled" ? "cancelled" : "completed";
        const observation = this.#observations.get(current.invocation_id);
        if (observation) {
          await this.#observe(
            current,
            observation,
            runtimeResult.status === "cancelled" ? "cancelled" : "completed",
            result.status,
            runtimeResult.status === "succeeded"
              ? result.status === "succeeded" ? "provider-succeeded" : "provider-unverified"
              : runtimeResult.status === "failed" ? "provider-failed" : "provider-cancelled",
          );
        }
      }
      return result;
    } catch {
      current.status = "completed";
      const observation = this.#observations.get(current.invocation_id);
      if (observation) await this.#observe(current, observation, "completed", "failed", "collection-failed");
      return {
        status: "failed", provider_id: current.provider_id, route_id: current.route_id, summary: "Provider result collection failed.",
        artifacts: [], evidence: [], verification: [], error: { code: "COLLECTION_FAILED", retryable: true },
      };
    }
  }

  async sessionSources(selection: SessionSourceSelection): Promise<SessionSource[]> {
    const allowedRoots = new Set(selection.roots);
    const sources = await this.#runtime.sessionSources(selection);
    return sources
      .filter((source) => source.source === this.host && allowedRoots.has(source.uri_alias))
      .map((source) => ({
        ...source,
        health: this.#compatibility.session_formats[source.format]?.includes(source.format_version) ? "healthy" as const : "incompatible" as const,
      }))
      .filter((source) => source.health === "healthy")
      .sort((left, right) => left.source_alias.localeCompare(right.source_alias));
  }
}

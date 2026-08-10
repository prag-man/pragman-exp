import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { satisfiesVersionRange, type HealthState, type HostId, type ProviderDefinition } from "../packages/provider-registry/src/index.ts";
import {
  createBoundedContext,
  type AdapterTaskContract,
  type BoundedContext,
  type CancellationResult,
  type HostAdapter,
  type HostCapability,
  type HostRuntime,
  type InvocationHandle,
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
}

function boundedSummary(value: string): string {
  return value.length <= 1_000 ? value : `${value.slice(0, 997)}...`;
}

const SENSITIVITY_RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 } as const;

function enforceContextPolicy(provider: ProviderDefinition, context: BoundedContext): void {
  const classes = new Set(provider.context_policy.accepted_classes);
  const sensitivities = [
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

  constructor(host: HostId, host_version: string, runtime: HostRuntime, compatibility: AdapterCompatibility) {
    this.host = host;
    this.host_version = host_version;
    this.#runtime = runtime;
    this.#compatibility = compatibility;
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
    if (this.health() !== "healthy") throw Object.assign(new Error("Host version is incompatible"), { code: "INCOMPATIBLE_HOST_VERSION" });
    if (!provider.host_support.includes(this.host)) throw Object.assign(new Error("Provider does not support this host"), { code: "HOST_UNSUPPORTED" });
    const safeContext = createBoundedContext(context);
    if (!isDeepStrictEqual(safeContext.task_contract, contract)) {
      throw Object.assign(new Error("Handoff context does not match its task contract"), { code: "CONTRACT_MISMATCH" });
    }
    enforceContextPolicy(provider, safeContext);
    const createHandle = (mode: InvocationHandle["mode"], status: InvocationHandle["status"], executionId: string | null, instructions: string[] = []): InvocationHandle => {
      const handle = {
        invocation_id: randomUUID(), provider_id: provider.id, route_id: contract.route_id,
        mode, status, execution_id: executionId, handoff_instructions: instructions,
      };
      this.#handles.set(handle.invocation_id, handle);
      return structuredClone(handle);
    };

    if (provider.invoke.kind === "manual") return createHandle("manual", "handoff-required", null, provider.invoke.instructions);
    if (provider.invoke.kind === "cli") {
      if (!this.#runtime.invokeCli) return createHandle("cli", "handoff-required", null, [`Run pragman ${provider.invoke.arguments.join(" ")}`]);
      const result = await this.#runtime.invokeCli({ provider_id: provider.id, executable: provider.invoke.executable, arguments: provider.invoke.arguments, contract, context: safeContext });
      return result.accepted && result.execution_id
        ? createHandle("cli", "running", result.execution_id)
        : createHandle("cli", "handoff-required", null, [`Run pragman ${provider.invoke.arguments.join(" ")}`]);
    }
    if (provider.invoke.kind === "native-skill" && this.#compatibility.native_skill_invocation && this.#runtime.invokeNative) {
      const result = await this.#runtime.invokeNative({ provider_id: provider.id, skill_id: provider.invoke.skill_id, contract, context: safeContext });
      if (result.accepted && result.execution_id) return createHandle("native-skill", "running", result.execution_id);
    }
    const prompt = provider.invoke.kind === "prompt-handoff"
      ? provider.invoke.prompt
      : `Invoke ${provider.invoke.skill_id} for route_id ${contract.route_id} at router_depth ${contract.router_depth}. Return only the declared provider result contract.`;
    if (this.#compatibility.prompt_handoff && this.#runtime.handoffPrompt) {
      const result = await this.#runtime.handoffPrompt({ provider_id: provider.id, prompt, contract, context: safeContext });
      if (result.acknowledged && result.execution_id) return createHandle("prompt-handoff", "running", result.execution_id);
    }
    return createHandle("prompt-handoff", "handoff-required", null, [prompt]);
  }

  async cancel(handle: InvocationHandle): Promise<CancellationResult> {
    const current = this.#handles.get(handle.invocation_id);
    if (!current || current.status !== "running" || !current.execution_id) return { cancelled: false, reason: "NOT_ACTIVE" };
    if (!this.#runtime.cancel) return { cancelled: false, reason: "UNSUPPORTED" };
    const result = await this.#runtime.cancel(current.execution_id);
    if (!result.cancelled) return { cancelled: false, reason: "HOST_REJECTED" };
    current.status = "cancelled";
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
      const result = normalizeRuntimeResult(current, await this.#runtime.collect(current.execution_id));
      if (["succeeded", "failed", "cancelled"].includes(result.status)) current.status = result.status === "cancelled" ? "cancelled" : "completed";
      return result;
    } catch {
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

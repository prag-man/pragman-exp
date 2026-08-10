import type {
  HealthState,
  HostId,
  ProviderDefinition,
  ProviderDiscovery,
  ProviderSideEffect,
  Sensitivity,
} from "../packages/provider-registry/src/index.ts";

export const BOUNDED_CONTEXT_LIMITS = Object.freeze({
  summaries: 12,
  summary_characters: 4_096,
  redacted_excerpts: 8,
  excerpt_characters: 2_048,
  total_characters: 32_768,
});

export interface AdapterTaskContract {
  schema_version: 1;
  route_id: string;
  router_depth: number;
  request_digest: string;
  outcome: string;
  capabilities: string[];
  allowed_side_effects: ProviderSideEffect[] | string[];
}

export interface ContextSummary {
  source_alias: string;
  sensitivity: Sensitivity;
  summary: string;
}

export interface RedactedExcerpt {
  source_alias: string;
  sensitivity: Sensitivity;
  excerpt: string;
  digest: string;
  approved: true;
}

export interface BoundedContext {
  task_contract: AdapterTaskContract;
  summaries: ContextSummary[];
  redacted_excerpts: RedactedExcerpt[];
}

export type InvocationMode = "native-skill" | "prompt-handoff" | "cli" | "manual";
export type InvocationStatus = "running" | "handoff-required" | "cancelled" | "completed";

export interface InvocationHandle {
  invocation_id: string;
  provider_id: string;
  route_id: string;
  mode: InvocationMode;
  status: InvocationStatus;
  execution_id: string | null;
  handoff_instructions: string[];
}

export interface CancellationResult {
  cancelled: boolean;
  reason: "UNSUPPORTED" | "NOT_ACTIVE" | "HOST_REJECTED" | null;
}

export interface ProviderVerification {
  code: string;
  passed: boolean;
}

export interface ProviderArtifact {
  artifact_id: string;
  kind: string;
  digest?: string;
}

export interface ProviderResult {
  status: "succeeded" | "partial" | "failed" | "cancelled" | "handoff-required";
  provider_id: string;
  route_id: string;
  summary: string;
  artifacts: ProviderArtifact[];
  evidence: string[];
  verification: ProviderVerification[];
  error: { code: string | null; retryable: boolean };
}

export interface RuntimeProviderResult {
  status: "running" | "succeeded" | "partial" | "failed" | "cancelled";
  summary: string;
  artifacts: ProviderArtifact[];
  evidence: string[];
  verification: ProviderVerification[];
  error?: { code: string | null; retryable: boolean };
}

export interface NativeInvocationRequest {
  provider_id: string;
  skill_id: string;
  contract: AdapterTaskContract;
  context: BoundedContext;
}

export interface PromptHandoffRequest {
  provider_id: string;
  prompt: string;
  contract: AdapterTaskContract;
  context: BoundedContext;
}

export interface SessionSourceSelection {
  roots: string[];
  from: string;
  through: string;
}

export interface RuntimeSessionSource {
  source: HostId;
  source_alias: string;
  format: string;
  format_version: string;
  uri_alias: string;
}

export interface SessionSource extends RuntimeSessionSource {
  health: "healthy" | "incompatible";
}

export interface HostRuntime {
  discover(): Promise<ProviderDiscovery[]>;
  invokeNative?(request: NativeInvocationRequest): Promise<{ accepted: boolean; execution_id?: string }>;
  handoffPrompt?(request: PromptHandoffRequest): Promise<{ acknowledged: boolean; execution_id?: string }>;
  invokeCli?(request: { provider_id: string; executable: "pragman"; arguments: string[]; contract: AdapterTaskContract; context: BoundedContext }): Promise<{ accepted: boolean; execution_id?: string }>;
  cancel?(executionId: string): Promise<{ cancelled: boolean }>;
  collect?(executionId: string): Promise<RuntimeProviderResult>;
  sessionSources(selection: SessionSourceSelection): Promise<RuntimeSessionSource[]>;
}

export type HostCapability = "discovery" | "native-skill" | "prompt-handoff" | "cli" | "cancellation" | "collection" | "session-sources";

export interface HostAdapter {
  readonly host: HostId;
  readonly host_version: string;
  health(): HealthState;
  capabilities(): HostCapability[];
  discover(): Promise<ProviderDiscovery[]>;
  invoke(provider: ProviderDefinition, contract: AdapterTaskContract, context: BoundedContext): Promise<InvocationHandle>;
  cancel(handle: InvocationHandle): Promise<CancellationResult>;
  collect(handle: InvocationHandle): Promise<ProviderResult>;
  sessionSources(selection: SessionSourceSelection): Promise<SessionSource[]>;
}

export class BoundedContextError extends Error {
  readonly code = "BOUNDED_CONTEXT_INVALID";
}

const ID = /^[a-z0-9]+(?:[a-z0-9:.-]*[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ROUTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/i;
const SENSITIVITY = new Set<Sensitivity>(["public", "internal", "confidential", "restricted"]);
const CONTEXT_FIELDS = new Set(["task_contract", "summaries", "redacted_excerpts"]);
const CONTRACT_FIELDS = new Set(["schema_version", "route_id", "router_depth", "request_digest", "outcome", "capabilities", "allowed_side_effects"]);
const SUMMARY_FIELDS = new Set(["source_alias", "sensitivity", "summary"]);
const EXCERPT_FIELDS = new Set(["source_alias", "sensitivity", "excerpt", "digest", "approved"]);

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}

export function createBoundedContext(value: unknown): BoundedContext {
  if (!plain(value) || !exact(value, CONTEXT_FIELDS) || !plain(value.task_contract)
    || !exact(value.task_contract, CONTRACT_FIELDS)) {
    throw new BoundedContextError("Bounded context contains unknown or malformed fields");
  }
  const contract = value.task_contract;
  if (contract.schema_version !== 1 || typeof contract.route_id !== "string" || !ROUTE_ID.test(contract.route_id)
    || !Number.isSafeInteger(contract.router_depth) || (contract.router_depth as number) < 0 || (contract.router_depth as number) > 3
    || typeof contract.request_digest !== "string" || !SHA256.test(contract.request_digest)
    || typeof contract.outcome !== "string" || contract.outcome.length === 0 || contract.outcome.length > 2_000
    || !Array.isArray(contract.capabilities) || !contract.capabilities.every((entry) => typeof entry === "string" && ID.test(entry))
    || !Array.isArray(contract.allowed_side_effects) || !contract.allowed_side_effects.every((entry) => typeof entry === "string" && ID.test(entry))) {
    throw new BoundedContextError("Task contract is not safe for provider handoff");
  }
  if (!Array.isArray(value.summaries) || value.summaries.length > BOUNDED_CONTEXT_LIMITS.summaries
    || !value.summaries.every((entry) => plain(entry) && exact(entry, SUMMARY_FIELDS)
      && typeof entry.source_alias === "string" && ID.test(entry.source_alias)
      && SENSITIVITY.has(entry.sensitivity as Sensitivity)
      && typeof entry.summary === "string" && entry.summary.length <= BOUNDED_CONTEXT_LIMITS.summary_characters)) {
    throw new BoundedContextError("Context summaries exceed the bounded contract");
  }
  if (!Array.isArray(value.redacted_excerpts) || value.redacted_excerpts.length > BOUNDED_CONTEXT_LIMITS.redacted_excerpts
    || !value.redacted_excerpts.every((entry) => plain(entry) && exact(entry, EXCERPT_FIELDS)
      && typeof entry.source_alias === "string" && ID.test(entry.source_alias)
      && SENSITIVITY.has(entry.sensitivity as Sensitivity)
      && typeof entry.excerpt === "string" && entry.excerpt.length <= BOUNDED_CONTEXT_LIMITS.excerpt_characters
      && typeof entry.digest === "string" && SHA256.test(entry.digest) && entry.approved === true)) {
    throw new BoundedContextError("Redacted excerpts exceed or bypass the bounded contract");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > BOUNDED_CONTEXT_LIMITS.total_characters) throw new BoundedContextError("Bounded context is too large");
  return structuredClone(value) as unknown as BoundedContext;
}

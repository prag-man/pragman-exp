import { createHash } from "node:crypto";

import type {
  HealthState,
  HostId,
  ProviderDefinition,
  ProviderDiscovery,
  ProviderSideEffect,
  Sensitivity,
} from "../packages/provider-registry/src/index.ts";
import type { SkillEvent } from "../packages/events/src/types.ts";
import type { EgressApproval } from "../packages/router/src/types.ts";
export type { EgressApproval } from "../packages/router/src/types.ts";

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
  providers: string[];
  provider_assignments: Array<{ provider_id: string; capabilities: string[] }>;
  allowed_side_effects: ProviderSideEffect[] | string[];
  effective_sensitivity: Sensitivity;
  egress_approvals: EgressApproval[];
}

export interface ContextSummary {
  source_alias: string;
  data_category: string;
  disclosed_field: string;
  sensitivity: Sensitivity;
  summary: string;
}

export interface RedactedExcerpt {
  source_alias: string;
  data_category: string;
  disclosed_field: string;
  sensitivity: Sensitivity;
  excerpt: string;
  digest: string;
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

export type ProviderLifecycleObserver = (event: SkillEvent) => void | Promise<void>;
export type EgressApprovalVerifier = (approval: Readonly<EgressApproval>) => boolean | Promise<boolean>;

export class BoundedContextError extends Error {
  readonly code = "BOUNDED_CONTEXT_INVALID";
}

const ID = /^[a-z0-9]+(?:[a-z0-9:.-]*[a-z0-9])?$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROVIDER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESTINATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ROUTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/i;
const SENSITIVITY = new Set<Sensitivity>(["public", "internal", "confidential", "restricted"]);
const CONTEXT_FIELDS = new Set(["task_contract", "summaries", "redacted_excerpts"]);
const CONTRACT_FIELDS = new Set([
  "schema_version", "route_id", "router_depth", "request_digest", "outcome", "capabilities", "providers",
  "provider_assignments", "allowed_side_effects", "effective_sensitivity", "egress_approvals",
]);
const SUMMARY_FIELDS = new Set(["source_alias", "data_category", "disclosed_field", "sensitivity", "summary"]);
const EXCERPT_FIELDS = new Set(["source_alias", "data_category", "disclosed_field", "sensitivity", "excerpt", "digest"]);
const APPROVAL_FIELDS = new Set([
  "schema_version", "approval_id", "route_id", "provider_id", "approved_at", "expires_at",
  "destination", "destination_id", "source_aliases", "data_categories", "disclosed_fields",
  "effective_sensitivity", "purpose", "retention", "further_calls_allowed", "content_digest",
]);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}

function exactSha256Bytes(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function validUtcInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function validEgressApproval(value: unknown): value is EgressApproval {
  return plain(value) && exact(value, APPROVAL_FIELDS)
    && value.schema_version === 1
    && typeof value.approval_id === "string" && ROUTE_ID.test(value.approval_id)
    && typeof value.route_id === "string" && ROUTE_ID.test(value.route_id)
    && typeof value.provider_id === "string" && PROVIDER_ID.test(value.provider_id)
    && (value.destination === "host-model" || value.destination === "mcp-connector" || value.destination === "research-provider"
      || value.destination === "external-skill" || value.destination === "local-process" || value.destination === "external-api")
    && typeof value.destination_id === "string" && value.destination_id.length <= 128 && DESTINATION_ID.test(value.destination_id)
    && Array.isArray(value.source_aliases) && value.source_aliases.length > 0 && value.source_aliases.length <= 32
    && value.source_aliases.every((entry) => typeof entry === "string" && SLUG.test(entry))
    && new Set(value.source_aliases).size === value.source_aliases.length
    && Array.isArray(value.data_categories) && value.data_categories.length > 0 && value.data_categories.length <= 32
    && value.data_categories.every((entry) => typeof entry === "string" && SLUG.test(entry))
    && new Set(value.data_categories).size === value.data_categories.length
    && Array.isArray(value.disclosed_fields) && value.disclosed_fields.length > 0 && value.disclosed_fields.length <= 32
    && value.disclosed_fields.every((entry) => typeof entry === "string" && SLUG.test(entry))
    && new Set(value.disclosed_fields).size === value.disclosed_fields.length
    && SENSITIVITY.has(value.effective_sensitivity as Sensitivity)
    && typeof value.purpose === "string" && value.purpose.length > 0 && value.purpose.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value.purpose)
    && typeof value.retention === "string" && value.retention.length > 0 && value.retention.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value.retention)
    && typeof value.further_calls_allowed === "boolean"
    && typeof value.content_digest === "string" && SHA256.test(value.content_digest)
    && validUtcInstant(value.approved_at)
    && validUtcInstant(value.expires_at);
}

/** Digest of the exact bounded disclosure, independent of object key order. */
export function boundedContextContentDigest(
  value: Pick<BoundedContext, "summaries" | "redacted_excerpts">,
): string {
  const hash = createHash("sha256");
  const add = (text: string) => {
    const bytes = Buffer.from(text, "utf8");
    hash.update(String(bytes.length));
    hash.update(":");
    hash.update(bytes);
    hash.update(";");
  };
  for (const entry of value.summaries) {
    add("summary"); add(entry.source_alias); add(entry.data_category); add(entry.disclosed_field); add(entry.sensitivity); add(entry.summary);
  }
  for (const entry of value.redacted_excerpts) {
    add("redacted-excerpt"); add(entry.source_alias); add(entry.data_category); add(entry.disclosed_field); add(entry.sensitivity); add(entry.excerpt);
  }
  return hash.digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plain(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validProviderAssignments(value: unknown, providerValue: unknown, capabilityValue: unknown): boolean {
  if (!Array.isArray(value) || !Array.isArray(providerValue) || !Array.isArray(capabilityValue)
    || value.length !== providerValue.length) return false;
  const providers = providerValue as string[];
  const capabilities = capabilityValue as string[];
  const valid = value.every((assignment) => plain(assignment)
    && exact(assignment, new Set(["provider_id", "capabilities"]))
    && typeof assignment.provider_id === "string" && providers.includes(assignment.provider_id)
    && Array.isArray(assignment.capabilities) && assignment.capabilities.length > 0
    && assignment.capabilities.every((entry) => typeof entry === "string" && ID.test(entry) && capabilities.includes(entry))
    && new Set(assignment.capabilities).size === assignment.capabilities.length);
  return valid
    && new Set(value.map((assignment) => assignment.provider_id)).size === providers.length
    && new Set(value.flatMap((assignment) => assignment.capabilities)).size === capabilities.length;
}

/** Stable digest of the provider definition that was actually selected for handoff. */
export function providerDefinitionDigest(provider: ProviderDefinition): string {
  return exactSha256Bytes(canonicalJson(provider));
}

/**
 * Digest of every value released to a runtime, including the selected provider
 * definition and destination. Egress approvals sign this digest; approvals are
 * omitted from the contract projection to avoid a self-referential digest.
 */
export function providerHandoffContentDigest(
  provider: ProviderDefinition,
  contract: AdapterTaskContract,
  context: Pick<BoundedContext, "summaries" | "redacted_excerpts">,
  destination: Pick<EgressApproval, "destination" | "destination_id">,
): string {
  const { egress_approvals: _approvals, ...approvedContract } = contract;
  return exactSha256Bytes(canonicalJson({
    schema_version: 1,
    provider,
    provider_digest: providerDefinitionDigest(provider),
    contract: approvedContract,
    context: {
      summaries: context.summaries,
      redacted_excerpts: context.redacted_excerpts,
    },
    destination,
  }));
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
    || !Array.isArray(contract.providers) || contract.providers.length === 0 || contract.providers.length > 32
    || !contract.providers.every((entry) => typeof entry === "string" && PROVIDER_ID.test(entry))
    || new Set(contract.providers).size !== contract.providers.length
    || !validProviderAssignments(contract.provider_assignments, contract.providers, contract.capabilities)
    || !Array.isArray(contract.allowed_side_effects) || !contract.allowed_side_effects.every((entry) => typeof entry === "string" && ID.test(entry))
    || !SENSITIVITY.has(contract.effective_sensitivity as Sensitivity)
    || !Array.isArray(contract.egress_approvals) || contract.egress_approvals.length > 32
    || !contract.egress_approvals.every(validEgressApproval)) {
    throw new BoundedContextError("Task contract is not safe for provider handoff");
  }
  if (!Array.isArray(value.summaries) || value.summaries.length > BOUNDED_CONTEXT_LIMITS.summaries
    || !value.summaries.every((entry) => plain(entry) && exact(entry, SUMMARY_FIELDS)
      && typeof entry.source_alias === "string" && SLUG.test(entry.source_alias)
      && typeof entry.data_category === "string" && SLUG.test(entry.data_category)
      && typeof entry.disclosed_field === "string" && SLUG.test(entry.disclosed_field)
      && SENSITIVITY.has(entry.sensitivity as Sensitivity)
      && typeof entry.summary === "string" && entry.summary.length <= BOUNDED_CONTEXT_LIMITS.summary_characters)) {
    throw new BoundedContextError("Context summaries exceed the bounded contract");
  }
  if (!Array.isArray(value.redacted_excerpts) || value.redacted_excerpts.length > BOUNDED_CONTEXT_LIMITS.redacted_excerpts
    || !value.redacted_excerpts.every((entry) => plain(entry) && exact(entry, EXCERPT_FIELDS)
      && typeof entry.source_alias === "string" && SLUG.test(entry.source_alias)
      && typeof entry.data_category === "string" && SLUG.test(entry.data_category)
      && typeof entry.disclosed_field === "string" && SLUG.test(entry.disclosed_field)
      && SENSITIVITY.has(entry.sensitivity as Sensitivity)
      && typeof entry.excerpt === "string" && entry.excerpt.length <= BOUNDED_CONTEXT_LIMITS.excerpt_characters
      && typeof entry.digest === "string" && SHA256.test(entry.digest)
      && entry.digest === exactSha256Bytes(entry.excerpt as string))) {
    throw new BoundedContextError("Redacted excerpts exceed or bypass the bounded contract");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > BOUNDED_CONTEXT_LIMITS.total_characters) throw new BoundedContextError("Bounded context is too large");
  return structuredClone(value) as unknown as BoundedContext;
}

export type TrustTier = "bundled" | "curated" | "workspace-approved" | "discovered";
export type HealthState = "unknown" | "healthy" | "degraded" | "missing" | "incompatible" | "conflict" | "quarantined";
export type HostId = "codex" | "claude-code" | "cursor";
export type Sensitivity = "public" | "internal" | "confidential" | "restricted";
export type WorkflowWeight = "light" | "standard" | "heavy";
export type InstallScope = "project" | "user" | "global";

export type ProviderSideEffect =
  | "read-files"
  | "run-commands"
  | "project-file-write"
  | "remote-egress"
  | "external-message"
  | "issue-write"
  | "pull-request-write"
  | "purchase"
  | "external-account-mutation"
  | "deploy"
  | "production-data-write"
  | "credential-access"
  | "destructive";

export type ContextClass = "task-contract" | "context-summary" | "redacted-excerpt";

export interface CapabilityDefinition {
  schema_version: 1;
  id: string;
  stage: number;
  depends_on: string[];
  result_contract: string;
  description?: string;
  incompatible_with?: string[];
}

export type ProviderInvocation =
  | { kind: "native-skill"; skill_id: string }
  | { kind: "prompt-handoff"; skill_id: string; prompt: string }
  | { kind: "cli"; executable: "pragman"; arguments: string[] }
  | { kind: "manual"; instructions: string[] };

export interface ProviderContextPolicy {
  accepted_classes: ContextClass[];
  maximum_sensitivity: Sensitivity;
  accepts_redacted_excerpts: boolean;
}

export interface ProviderCompatibility {
  source_version?: string;
  hosts?: Partial<Record<HostId, string>>;
}

export interface ProviderDefinition {
  schema_version: 1;
  id: string;
  source: string;
  source_version: string;
  trust: TrustTier;
  capabilities: string[];
  host_support: HostId[];
  invoke: ProviderInvocation;
  context_policy: ProviderContextPolicy;
  side_effects: ProviderSideEffect[];
  workflow_weight: WorkflowWeight;
  result_contract: string;
  requires?: string[];
  strengths?: string[];
  best_for?: string[];
  avoid_when?: string[];
  compatibility?: ProviderCompatibility;
  evaluation_confidence?: number;
}

/** Canonical discovery identity. `trust` is local approval metadata, not source content. */
export interface ProviderDiscovery {
  source: string;
  skill_id: string;
  version: string;
  install_scope: InstallScope;
  path_alias: string;
  digest: string;
  trust?: TrustTier;
}

export interface ProviderHealthSnapshot {
  provider_id: string;
  version: string;
  digest: string;
  health: HealthState;
}

export type ProviderStatusReason =
  | "DIGEST_DRIFT"
  | "VERSION_DRIFT"
  | "HOST_UNSUPPORTED"
  | "HOST_VERSION_UNSUPPORTED"
  | "SOURCE_VERSION_UNSUPPORTED"
  | "NOT_INSTALLED"
  | "MANUAL_HANDOFF"
  | "PROMPT_HANDOFF"
  | "SHADOW_CONFLICT"
  | "QUARANTINED";

export interface ProviderRegistryStatus {
  health: HealthState;
  reason: ProviderStatusReason | null;
  selected_path_alias: string | null;
  selected_digest: string | null;
  shadowed_path_aliases: string[];
}

export interface ProviderRegistryIssue {
  code:
    | "INVALID_DOCUMENT"
    | "UNKNOWN_FIELD"
    | "INVALID_FIELD"
    | "INVALID_TRUST"
    | "DUPLICATE_CAPABILITY"
    | "DUPLICATE_PROVIDER"
    | "MISSING_CAPABILITY"
    | "MISSING_DEPENDENCY"
    | "CAPABILITY_CYCLE"
    | "INVALID_INCOMPATIBILITY"
    | "UNSAFE_EXECUTABLE";
  path: string;
  message: string;
}

export interface CreateProviderRegistryInput {
  capabilities: readonly CapabilityDefinition[];
  providers: readonly ProviderDefinition[];
  discoveries?: readonly ProviderDiscovery[];
  previous_health?: readonly ProviderHealthSnapshot[];
  host?: HostId;
  host_version?: string;
}

export interface LoadProviderRegistryInput extends Omit<CreateProviderRegistryInput, "capabilities" | "providers"> {
  directory: string;
}

export type RequestedCapabilityValidation =
  | { ok: true }
  | { ok: false; code: "UNKNOWN_CAPABILITY"; capabilities: string[] }
  | { ok: false; code: "INCOMPATIBLE_CAPABILITIES"; capabilities: string[] };

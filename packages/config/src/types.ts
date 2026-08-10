export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ConfigErrorCode =
  | "INVALID_CONFIGURATION"
  | "INCOMPATIBLE_VERSION"
  | "INVALID_PATH"
  | "WORKSPACE_MISMATCH"
  | "NOT_FOUND"
  | "INVALID_PATCH"
  | "STALE_PREVIEW"
  | "TEMPORARY_FAILURE";

export class ConfigError extends Error {
  public readonly code: ConfigErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ConfigErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.details = details;
  }
}

export interface PersonalConfig extends JsonObject {
  schema_version: 1;
  privacy: JsonObject;
  updates: JsonObject;
  output: JsonObject;
}

export interface PersonalProfile extends JsonObject {
  schema_version: 1;
  profile_id: string;
  roles: string[];
  responsibilities: string[];
  preferences?: JsonObject;
  prohibitions?: string[];
  authority?: string[];
}

export interface ContextSource extends JsonObject {
  id: string;
  kind: string;
  uri: string;
  description: string;
  sensitivity: string;
}

export interface WorkspaceConfig extends JsonObject {
  schema_version: 1;
  workspace_id: string;
  name: string;
  root: string;
  context_sources: ContextSource[];
}

export interface ProjectManifest extends JsonObject {
  schema_version: 1;
  project_id: string;
  workspace: string;
  root: string;
  additional_workspaces?: string[];
  context_index?: string;
}

export type ContextMode = "personal-only" | "workspace-only" | "project-linked";

export interface LoadedConfigurationContext {
  mode: ContextMode;
  personal: PersonalConfig;
  profile?: PersonalProfile;
  primaryWorkspace?: WorkspaceConfig;
  project?: ProjectManifest;
  additionalWorkspaces: WorkspaceConfig[];
  paths: {
    personal: string;
    profile?: string;
    primaryWorkspace?: string;
    project?: string;
    additionalWorkspaces: string[];
  };
}

export type PrimaryLayerName = "explicit" | "project" | "primary-workspace" | "personal" | "defaults";

export interface ProvenanceContributor {
  layer: PrimaryLayerName | "additional-workspace";
  sourceId?: string;
}

export interface FieldProvenance extends ProvenanceContributor {
  contributors?: ProvenanceContributor[];
}

export interface AdditionalWorkspaceLayer {
  workspaceId: string;
  value: JsonObject;
}

export interface AdditionalWorkspaceConflictValue {
  workspaceId: string;
  value: JsonValue;
}

export interface AdditionalWorkspaceConflict {
  path: string;
  values: AdditionalWorkspaceConflictValue[];
}

export interface ResolvedRoutingRule {
  layer: PrimaryLayerName;
  rule: JsonObject & { id: string };
}

export interface AdditionalRoutingCandidate {
  workspaceId: string;
  advisory: true;
  rule: JsonObject & { id: string };
}

export interface MergeConfigurationInput {
  explicit?: JsonObject;
  project?: JsonObject;
  primaryWorkspace?: JsonObject;
  personal?: JsonObject;
  defaults?: JsonObject;
  additionalWorkspaces?: AdditionalWorkspaceLayer[];
}

export interface MergeConfigurationResult {
  value: JsonObject;
  provenance: Record<string, FieldProvenance>;
  additionalWorkspaceConflicts: AdditionalWorkspaceConflict[];
  routingRules: ResolvedRoutingRule[];
  additionalRoutingCandidates: AdditionalRoutingCandidate[];
}

export type PatchOperation =
  | { op: "add" | "replace"; path: string; value: JsonValue }
  | { op: "remove"; path: string };

export type ChangeTarget = "personal" | "workspace" | "project";

export interface ChangeRecord {
  schema_version: 1;
  change_id: string;
  target: ChangeTarget;
  target_id: string;
  base_digest: string;
  preview_digest: string;
  operations: PatchOperation[];
  reason: string;
  evidence_refs: string[];
  approved_by: "local-user";
  approved_at: string;
  applied_at: string | null;
  rollback: {
    available: boolean;
    snapshot_ref: string;
    rolled_back_at: string | null;
  };
}

export interface ChangePreview extends ChangeRecord {
  stateRoot: string;
  targetPath: string;
  proposedBytes: Uint8Array;
}

export interface AppliedChange {
  record: ChangeRecord;
  snapshotPath: string;
}

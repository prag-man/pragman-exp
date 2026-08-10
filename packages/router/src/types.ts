export type TaskFamily = "explain" | "research" | "shape" | "prototype" | "implement" | "debug" | "review" | "analyze" | "operate" | "administer";
export type Lane = "fast" | "standard" | "deep" | "operational";
export type Sensitivity = "public" | "internal" | "confidential" | "restricted";
export type ApprovalType = "route" | "egress" | "action" | "target-specific" | "host-action";
export type SideEffect = "project-file-write" | "workspace-file-write" | "credential-use" | "destructive-action" | "paid-external-action" | "production-data-write" | "external-message" | "issue-write" | "pull-request-write" | "purchase" | "external-account-mutation" | "deployment" | "live-data-write";
export type EgressDestination = "host-model" | "mcp-connector" | "research-provider" | "external-skill" | "local-process" | "external-api";

export interface RouteInput {
  request: string;
  task_family: TaskFamily;
  desired_outcome: string;
  deliverable_kind: "response-only" | "local-artifact" | "project-change" | "external-action";
  execution_mode: "serial" | "independent-fanout";
  declared_side_effects: SideEffect[];
  data_inputs: Array<{ id: string; source_alias: string; category: string; sensitivity: Sensitivity }>;
  egress_destinations: EgressDestination[];
  urgency: "normal" | "urgent";
  uncertainties: Array<{ id: string; description: string; impact: "low" | "medium" | "high" }>;
  scope_systems: string[];
  estimated_sessions: "one" | "multiple" | "unknown";
  downstream_impact: "low" | "medium" | "high";
  reversibility: "reversible" | "costly" | "irreversible";
  requested_capabilities: string[];
  workspace: string | null;
  project: string | null;
}

export type ProviderTrust = "bundled" | "curated" | "workspace-approved" | "discovered";
export type ProviderHealth = "unknown" | "healthy" | "degraded" | "missing" | "incompatible" | "conflict" | "quarantined";
export type WorkflowWeight = "light" | "standard" | "heavy";

/** Minimal router view; provider-registry records adapt by deterministic field projection. */
export interface Provider {
  id: string;
  installed: boolean;
  handoffCapable: boolean;
  health: ProviderHealth;
  compatible: boolean;
  capabilities: string[];
  hostSupport: string[];
  trust: ProviderTrust;
  contextMaximumSensitivity: Sensitivity;
  trustMaximumSensitivity: Sensitivity;
  sideEffects: SideEffect[];
  workflowWeight: WorkflowWeight;
  evaluationConfidence?: number;
}

export interface Capability {
  id: string;
  stage: number;
  dependsOn: string[];
  incompatibleWith: string[];
}

export interface ApprovedOutcome {
  providerId: string;
  taskFamily: TaskFamily;
  sensitivity: Sensitivity;
  status: "succeeded" | "partial" | "failed" | "rolled-back";
  retained: boolean;
  completedAt: string;
  learningId: string;
}

export type RuleLayer = "explicit" | "project" | "workspace" | "personal" | "defaults" | "additional-workspace";
export type RuleCondition = { field: string; op: string; value?: unknown };
export type RuleExpression = { all: Array<RuleExpression | RuleCondition> } | { any: Array<RuleExpression | RuleCondition> } | { not: RuleExpression | RuleCondition };
export interface RoutingRule {
  id: string;
  layer: RuleLayer;
  priority: number;
  when: RuleExpression;
  action: {
    require_capabilities?: string[];
    prefer?: string[];
    avoid?: string[];
    minimum_lane?: Lane;
    require_approval?: Exclude<ApprovalType, "host-action"> | null;
  };
}

export interface RuleFacts extends RouteInput {
  effective_sensitivity: Sensitivity;
  data_categories: string[];
  uncertainty_max_impact: "low" | "medium" | "high";
  independent_system_count: number;
}

export interface ScoreComponent { reason: string; points: number }
export interface RankedProvider { provider: Provider; score: number; components: ScoreComponent[]; extraCapabilityCount: number }
export interface RejectedProvider { providerId: string; reasons: string[] }

export interface SequenceProvider extends RankedProvider { assignedCapabilities: string[] }
export interface ProviderSequence { providers: SequenceProvider[]; truncated: boolean }

export interface ApprovalRequirement { type: ApprovalType | "preview"; reason: string; required: boolean; hostNative?: boolean }
export interface EgressApproval { destination: EgressDestination; sensitivity: Sensitivity; digest: string }

export interface TaskContract {
  schema_version: 1;
  route_id: string;
  parent_route_id: string | null;
  request_digest: string;
  outcome: string;
  lane: Lane;
  deliverable_kind: RouteInput["deliverable_kind"];
  execution_mode: RouteInput["execution_mode"];
  workspace: string | null;
  project: string | null;
  in_scope: string[];
  out_of_scope: string[];
  assumptions: string[];
  unresolved_conflicts: string[];
  capabilities: string[];
  providers: string[];
  provider_sequence_policy: "stop" | "continue-independent" | "fallback";
  allowed_side_effects: SideEffect[];
  data_inputs: RouteInput["data_inputs"];
  effective_sensitivity: Sensitivity;
  egress_approvals: EgressApproval[];
  proof: string[];
  stop_conditions: string[];
  created_at: string;
}

export type RouterStatus = "ready" | "existing" | "needs-input" | "missing-provider" | "needs-route-split" | "invalid-execution-mode";
export interface RouteExplanation {
  laneReasons: string[];
  matchedRules: string[];
  eligibleProviders: Array<{ id: string; score: number; components: ScoreComponent[] }>;
  rejectedProviders: RejectedProvider[];
  truncation: boolean;
  fallbackState: string;
}
export interface RouteResultBase { status: RouterStatus; contextMode: "personal-only" | "workspace-only" | "project-linked"; explanation: RouteExplanation }
export interface ReadyRoute extends RouteResultBase { status: "ready"; contract: TaskContract; approvals: ApprovalRequirement[]; sequence: ProviderSequence }
export interface ExistingRoute extends RouteResultBase { status: "existing"; contract: TaskContract; approvals: ApprovalRequirement[]; sequence: ProviderSequence }
export interface BlockedRoute extends RouteResultBase { status: Exclude<RouterStatus, "ready" | "existing">; code: string; requiredInput?: string; recommendations?: string[] }
export type RouteResult = ReadyRoute | ExistingRoute | BlockedRoute;

export class RouterError extends Error {
  public readonly code: string;
  public readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.details = details;
  }
}

import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { deriveApprovals } from "./approvals.ts";
import { deriveLane, laneReasons } from "./lanes.ts";
import { applyRoutingRules, effectiveSensitivity } from "./rules.ts";
import { rankProviders } from "./scoring.ts";
import { chooseProviderSequence, resolveCapabilityClosure, selectFallback } from "./sequences.ts";
import { RouterError, type ApprovalRequirement, type Capability, type Lane, type Provider, type ProviderSequence, type RouteExplanation, type RouteInput, type RouteResult, type RoutingRule, type Sensitivity, type SideEffect, type TaskContract, type ApprovedOutcome } from "./types.ts";

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function uuidV7(): string {
  const bytes = randomBytes(16); let milliseconds = Date.now();
  for (let index = 5; index >= 0; index -= 1) { bytes[index] = milliseconds & 0xff; milliseconds = Math.floor(milliseconds / 256); }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

export interface RouteOptions {
  providers: Provider[];
  capabilities: Capability[];
  activeHost: string;
  allowedSideEffects: SideEffect[];
  projectLinks?: Record<string, string | null>;
  secondaryConflicts?: Array<{ path: string; values: unknown[] }>;
  resolvedSecondaryConflicts?: Record<string, unknown>;
  routingRules?: RoutingRule[];
  explicitLane?: Lane;
  prohibitLaneDecrease?: boolean;
  explicitProviders?: string[];
  projectPreferences?: string[];
  workspacePreferences?: string[];
  personalPreferences?: string[];
  prohibitedProviders?: string[];
  outcomes?: ApprovedOutcome[];
  routeId?: string;
  parentRouteId?: string | null;
  routerDepth?: number;
  existingContracts?: ReadonlyMap<string, TaskContract>;
  assumptions?: string[];
  inScope?: string[];
  outOfScope?: string[];
  proof?: string[];
  stopConditions?: string[];
  sequencePolicy?: "stop" | "continue-independent" | "fallback";
  createdAt?: Date;
  egressApprovals?: TaskContract["egress_approvals"];
  preferredWorkflowWeight?: Provider["workflowWeight"];
}

function explanation(laneReasons_: string[] = []): RouteExplanation {
  return { laneReasons: laneReasons_, matchedRules: [], eligibleProviders: [], rejectedProviders: [], truncation: false, fallbackState: "not-evaluated" };
}

function context(input: RouteInput, options: RouteOptions): { mode: RouteResult["contextMode"]; workspace: string | null; error?: { code: string; requiredInput: string } } {
  if (input.project) {
    const linked = options.projectLinks?.[input.project];
    if (!linked) return { mode: "project-linked", workspace: input.workspace, error: { code: "NEEDS_INPUT", requiredInput: `primary-workspace-for:${input.project}` } };
    if (input.workspace && input.workspace !== linked) return { mode: "project-linked", workspace: input.workspace, error: { code: "WORKSPACE_MISMATCH", requiredInput: `choose-workspace:${linked}` } };
    return { mode: "project-linked", workspace: linked };
  }
  return { mode: input.workspace ? "workspace-only" : "personal-only", workspace: input.workspace };
}

function sequenceForExisting(contract: TaskContract, providers: Provider[]): ProviderSequence {
  return { truncated: false, providers: contract.providers.flatMap((id) => {
    const provider = providers.find((entry) => entry.id === id);
    return provider ? [{ provider, score: 0, components: [], extraCapabilityCount: 0, assignedCapabilities: provider.capabilities.filter((capability) => contract.capabilities.includes(capability)) }] : [];
  }) };
}

function conflictResolutionMatches(conflict: { path: string; values: unknown[] }, resolutions: Record<string, unknown>): boolean {
  if (!Object.hasOwn(resolutions, conflict.path)) return false;
  const selected = resolutions[conflict.path];
  return conflict.values.some((candidate) => isDeepStrictEqual(candidate, selected)
    || (typeof selected === "string" && candidate !== null && typeof candidate === "object"
      && "workspaceId" in candidate && (candidate as { workspaceId?: unknown }).workspaceId === selected));
}

export function routeTask(input: RouteInput, options: RouteOptions): RouteResult {
  const initialContext = context(input, options);
  const routeId = options.routeId ?? uuidV7();
  const existing = options.existingContracts?.get(routeId);
  if (existing) {
    const sequence = sequenceForExisting(existing, options.providers);
    return { status: "existing", contextMode: initialContext.mode, contract: existing, sequence, approvals: deriveApprovals(input, existing.lane), explanation: explanation(["existing-route-id-returned"]), };
  }
  const depth = options.routerDepth ?? (options.parentRouteId ? 1 : 0);
  if (depth > 3) throw new RouterError("ROUTE_RECURSION", "Router depth exceeds 3", { parentRouteId: options.parentRouteId ?? null });
  const initialLane = deriveLane(input, { ...(options.explicitLane ? { explicitLane: options.explicitLane } : {}), ...(options.prohibitLaneDecrease ? { prohibitLaneDecrease: true } : {}) });
  const laneInfo = laneReasons(input);
  const routeExplanation = explanation(laneInfo.reasons);
  if (initialContext.error) return { status: "needs-input", contextMode: initialContext.mode, code: initialContext.error.code, requiredInput: initialContext.error.requiredInput, explanation: routeExplanation };

  const secondaryConflicts = options.secondaryConflicts ?? [];
  const resolutions = options.resolvedSecondaryConflicts ?? {};
  const conflictPaths = new Set(secondaryConflicts.map((conflict) => conflict.path));
  if (Object.keys(resolutions).some((path) => !conflictPaths.has(path))) {
    throw new RouterError("INVALID_INPUT", "Secondary conflict resolution refers to an unknown conflict path");
  }
  const unresolvedSecondary = secondaryConflicts.filter((conflict) => !conflictResolutionMatches(conflict, resolutions));
  if (unresolvedSecondary.length > 0) return { status: "needs-input", contextMode: initialContext.mode, code: "NEEDS_INPUT", requiredInput: `resolve-secondary-workspace-conflict:${unresolvedSecondary[0]!.path}`, explanation: routeExplanation };

  const rules = applyRoutingRules({ ...input, workspace: initialContext.workspace }, options.routingRules ?? [], initialLane);
  const requiredCapabilities = resolveCapabilityClosure(options.capabilities, rules.requiredCapabilities);
  const lane = rules.minimumLane;
  routeExplanation.matchedRules = rules.matchedRuleIds;
  const rank = rankProviders(options.providers, { ...input, workspace: initialContext.workspace, requested_capabilities: requiredCapabilities }, {
    activeHost: options.activeHost,
    allowedSideEffects: options.allowedSideEffects,
    requiredCapabilities,
    lane,
    explicitProviders: [...(options.explicitProviders ?? []), ...rules.preferencesByLayer.explicit],
    projectPreferences: [...(options.projectPreferences ?? []), ...rules.preferencesByLayer.project],
    workspacePreferences: [...(options.workspacePreferences ?? []), ...rules.preferencesByLayer.workspace],
    personalPreferences: [...(options.personalPreferences ?? []), ...rules.preferencesByLayer.personal],
    avoidProviders: [...(options.prohibitedProviders ?? []), ...rules.avoid],
    ...(options.outcomes ? { outcomes: options.outcomes } : {}),
  });
  routeExplanation.eligibleProviders = rank.eligible.map((entry) => ({ id: entry.provider.id, score: entry.score, components: entry.components }));
  routeExplanation.rejectedProviders = rank.rejected;
  if (requiredCapabilities.length > 0 && rank.eligible.length === 0) {
    return { status: "missing-provider", contextMode: initialContext.mode, code: "MISSING_PROVIDER", recommendations: requiredCapabilities.map((capability) => `install-or-approve-provider:${capability}`), explanation: routeExplanation };
  }
  let sequence: ProviderSequence;
  try {
    sequence = chooseProviderSequence(rank.eligible, options.capabilities, requiredCapabilities, input.execution_mode);
  } catch (error) {
    if (error instanceof RouterError && error.code === "NEEDS_ROUTE_SPLIT") return { status: "needs-route-split", contextMode: initialContext.mode, code: error.code, explanation: routeExplanation };
    if (error instanceof RouterError && error.code === "INVALID_EXECUTION_MODE") return { status: "invalid-execution-mode", contextMode: initialContext.mode, code: error.code, explanation: routeExplanation };
    throw error;
  }
  routeExplanation.truncation = sequence.truncated;
  const firstProvider = sequence.providers[0]?.provider;
  if (firstProvider) {
    const fallback = selectFallback(firstProvider, rank.eligible.filter((entry) => entry.provider.id !== firstProvider.id).map((entry) => entry.provider), { allowedSideEffects: options.allowedSideEffects, sensitivity: effectiveSensitivity(input) });
    routeExplanation.fallbackState = fallback ? (fallback.approvalRequired ? "available-approval-required" : "available-compatible") : "no-compatible-fallback";
  } else routeExplanation.fallbackState = "not-required";

  const unexpectedHeavy = Boolean(firstProvider && firstProvider.workflowWeight === "heavy" && options.preferredWorkflowWeight && options.preferredWorkflowWeight !== "heavy");
  const approvals: ApprovalRequirement[] = deriveApprovals(input, lane, { ruleApprovals: rules.requiredApprovals, materialAssumptions: (options.assumptions?.length ?? 0) > 0, unexpectedHeavyProvider: unexpectedHeavy });
  const policy = options.sequencePolicy ?? "stop";
  if (policy === "continue-independent" && input.execution_mode !== "independent-fanout") throw new RouterError("INVALID_SEQUENCE_POLICY", "continue-independent requires independent fan-out");
  const contract: TaskContract = {
    schema_version: 1,
    route_id: routeId,
    parent_route_id: options.parentRouteId ?? null,
    request_digest: digest(input.request),
    outcome: input.desired_outcome,
    lane,
    deliverable_kind: input.deliverable_kind,
    execution_mode: input.execution_mode,
    workspace: initialContext.workspace,
    project: input.project,
    in_scope: [...(options.inScope ?? [])], out_of_scope: [...(options.outOfScope ?? [])], assumptions: [...(options.assumptions ?? [])],
    unresolved_conflicts: [...new Set(unresolvedSecondary.map((conflict) => conflict.path))],
    capabilities: [...requiredCapabilities], providers: sequence.providers.map((entry) => entry.provider.id), provider_sequence_policy: policy,
    allowed_side_effects: [...input.declared_side_effects], data_inputs: structuredClone(input.data_inputs), effective_sensitivity: effectiveSensitivity(input),
    egress_approvals: structuredClone(options.egressApprovals ?? []), proof: [...(options.proof ?? [])], stop_conditions: [...(options.stopConditions ?? [])],
    created_at: (options.createdAt ?? new Date()).toISOString(),
  };
  freezeDeep(contract);
  return { status: "ready", contextMode: initialContext.mode, contract, approvals, sequence, explanation: routeExplanation };
}

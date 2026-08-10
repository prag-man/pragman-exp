import { deriveLane } from "./lanes.ts";
import { effectiveSensitivity } from "./rules.ts";
import type { ApprovedOutcome, Lane, Provider, ProviderTrust, RankedProvider, RejectedProvider, RouteInput, ScoreComponent, Sensitivity, SideEffect, WorkflowWeight } from "./types.ts";

const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
export const TRUST_RANK: Record<ProviderTrust, number> = { bundled: 4, curated: 3, "workspace-approved": 2, discovered: 1 };
export const WEIGHT_RANK: Record<WorkflowWeight, number> = { light: 1, standard: 2, heavy: 3 };

export function calculateOutcomeConfidence(providerId: string, taskFamily: RouteInput["task_family"], sensitivity: Sensitivity, outcomes: ApprovedOutcome[]): number {
  const retained = outcomes
    .filter((outcome) => outcome.retained && outcome.providerId === providerId && outcome.taskFamily === taskFamily && outcome.sensitivity === sensitivity)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt) || left.learningId.localeCompare(right.learningId))
    .slice(0, 20);
  if (retained.length === 0) return 0;
  const succeeded = retained.filter((outcome) => outcome.status === "succeeded").length;
  const partial = retained.filter((outcome) => outcome.status === "partial").length;
  return Math.floor(20 * (succeeded + 0.5 * partial) / (retained.length + 2));
}

export interface RankProvidersOptions {
  activeHost: string;
  allowedSideEffects: SideEffect[];
  requiredCapabilities?: string[];
  lane?: Lane;
  explicitProviders?: string[];
  projectPreferences?: string[];
  workspacePreferences?: string[];
  personalPreferences?: string[];
  avoidProviders?: string[];
  outcomes?: ApprovedOutcome[];
}

function rejectionReasons(provider: Provider, input: RouteInput, options: RankProvidersOptions, sensitivity: Sensitivity, required: string[]): string[] {
  const reasons: string[] = [];
  if (!provider.installed && !provider.handoffCapable) reasons.push("not-installed-or-handoff-capable");
  if (provider.health !== "healthy" && !(provider.health === "degraded" && provider.handoffCapable)) reasons.push(`health-${provider.health}`);
  if (!provider.compatible) reasons.push("version-incompatible");
  if (!provider.capabilities.some((capability) => required.includes(capability))) reasons.push("no-required-capability");
  if (!provider.hostSupport.includes(options.activeHost)) reasons.push("host-unsupported");
  if (provider.trust === "discovered") reasons.push("unapproved-trust");
  if (SENSITIVITY_RANK[provider.contextMaximumSensitivity] < SENSITIVITY_RANK[sensitivity]) reasons.push("context-sensitivity-denied");
  if (SENSITIVITY_RANK[provider.trustMaximumSensitivity] < SENSITIVITY_RANK[sensitivity]) reasons.push("trust-sensitivity-denied");
  if (provider.sideEffects.some((effect) => !options.allowedSideEffects.includes(effect))) reasons.push("side-effect-not-allowed");
  if (options.avoidProviders?.includes(provider.id)) reasons.push("prohibited-or-avoided");
  return reasons;
}

function add(components: ScoreComponent[], reason: string, points: number): void { components.push({ reason, points }); }

export function compareRankedProviders(left: RankedProvider, right: RankedProvider): number {
  return right.score - left.score
    || TRUST_RANK[right.provider.trust] - TRUST_RANK[left.provider.trust]
    || left.extraCapabilityCount - right.extraCapabilityCount
    || WEIGHT_RANK[left.provider.workflowWeight] - WEIGHT_RANK[right.provider.workflowWeight]
    || left.provider.id.localeCompare(right.provider.id);
}

export function rankProviders(providers: Provider[], input: RouteInput, options: RankProvidersOptions): { eligible: RankedProvider[]; rejected: RejectedProvider[] } {
  const sensitivity = effectiveSensitivity(input);
  const required = options.requiredCapabilities ?? input.requested_capabilities;
  const lane = options.lane ?? deriveLane(input);
  const eligible: RankedProvider[] = [];
  const rejected: RejectedProvider[] = [];
  for (const provider of providers) {
    const reasons = rejectionReasons(provider, input, options, sensitivity, required);
    if (reasons.length > 0) { rejected.push({ providerId: provider.id, reasons }); continue; }
    const components: ScoreComponent[] = [];
    const isPreferred = Boolean(options.explicitProviders?.includes(provider.id) || options.projectPreferences?.includes(provider.id) || options.workspacePreferences?.includes(provider.id) || options.personalPreferences?.includes(provider.id));
    if (options.explicitProviders?.includes(provider.id)) add(components, "explicit-selection", 1000);
    if (options.projectPreferences?.includes(provider.id)) add(components, "project-preference", 300);
    if (options.workspacePreferences?.includes(provider.id)) add(components, "workspace-preference", 200);
    if (options.personalPreferences?.includes(provider.id)) add(components, "personal-preference", 100);
    add(components, "trust", provider.trust === "curated" ? 40 : provider.trust === "workspace-approved" ? 20 : provider.trust === "bundled" && !isPreferred ? 10 : 0);
    add(components, "required-capabilities", 10 * provider.capabilities.filter((capability) => required.includes(capability)).length);
    add(components, "outcome-confidence", calculateOutcomeConfidence(provider.id, input.task_family, sensitivity, options.outcomes ?? []));
    if (provider.workflowWeight === "heavy" && lane === "fast") add(components, "workflow-penalty", -50);
    else if (provider.workflowWeight === "heavy" && lane === "standard") add(components, "workflow-penalty", -20);
    const score = components.reduce((sum, component) => sum + component.points, 0);
    eligible.push({ provider, score, components, extraCapabilityCount: provider.capabilities.filter((capability) => !required.includes(capability)).length });
  }
  eligible.sort(compareRankedProviders);
  rejected.sort((left, right) => left.providerId.localeCompare(right.providerId));
  return { eligible, rejected };
}

import { compareRankedProviders, TRUST_RANK, WEIGHT_RANK } from "./scoring.ts";
import { RouterError, type Capability, type Provider, type ProviderSequence, type RankedProvider, type Sensitivity, type SideEffect } from "./types.ts";

function validateCapabilities(capabilities: Capability[], requested: string[]): Map<string, Capability> {
  const map = new Map<string, Capability>();
  for (const capability of capabilities) {
    if (map.has(capability.id)) throw new RouterError("INVALID_CAPABILITY_GRAPH", `Duplicate capability ${capability.id}`);
    if (!Number.isInteger(capability.stage) || capability.stage < 0 || capability.stage > 100) throw new RouterError("INVALID_CAPABILITY_GRAPH", `Invalid stage for ${capability.id}`);
    map.set(capability.id, capability);
  }
  for (const capability of capabilities) for (const dependency of capability.dependsOn) if (!map.has(dependency)) throw new RouterError("INVALID_CAPABILITY_GRAPH", `Missing dependency ${dependency}`);
  for (const id of requested) if (!map.has(id)) throw new RouterError("INVALID_CAPABILITY_GRAPH", `Unknown requested capability ${id}`);
  for (const id of requested) {
    const capability = map.get(id)!;
    const conflict = capability.incompatibleWith.find((other) => requested.includes(other));
    if (conflict) throw new RouterError("INVALID_CAPABILITY_GRAPH", `Incompatible requested capabilities: ${id}, ${conflict}`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new RouterError("INVALID_CAPABILITY_GRAPH", "Capability dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of map.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of map.keys()) visit(id);
  return map;
}

export function resolveCapabilityClosure(capabilities: Capability[], requested: string[]): string[] {
  const map = validateCapabilities(capabilities, requested);
  const result: string[] = [];
  const seen = new Set<string>();
  const include = (id: string): void => {
    if (seen.has(id)) return;
    for (const dependency of map.get(id)!.dependsOn) include(dependency);
    seen.add(id);
    result.push(id);
  };
  for (const id of requested) include(id);
  return result;
}

function combinations<T>(items: T[], size: number, start = 0, prefix: T[] = [], output: T[][] = []): T[][] {
  if (prefix.length === size) { output.push(prefix); return output; }
  for (let index = start; index <= items.length - (size - prefix.length); index += 1) combinations(items, size, index + 1, [...prefix, items[index]!], output);
  return output;
}

interface CandidateSequence { providers: Array<RankedProvider & { assignedCapabilities: string[] }> }

function compareSequences(left: CandidateSequence, right: CandidateSequence): number {
  const leftScore = left.providers.reduce((sum, entry) => sum + entry.score, 0);
  const rightScore = right.providers.reduce((sum, entry) => sum + entry.score, 0);
  const leftWeight = left.providers.reduce((sum, entry) => sum + WEIGHT_RANK[entry.provider.workflowWeight], 0);
  const rightWeight = right.providers.reduce((sum, entry) => sum + WEIGHT_RANK[entry.provider.workflowWeight], 0);
  const leftTrust = Math.min(...left.providers.map((entry) => TRUST_RANK[entry.provider.trust]));
  const rightTrust = Math.min(...right.providers.map((entry) => TRUST_RANK[entry.provider.trust]));
  const leftIds = left.providers.map((entry) => entry.provider.id).sort().join("\0");
  const rightIds = right.providers.map((entry) => entry.provider.id).sort().join("\0");
  return left.providers.length - right.providers.length || rightScore - leftScore || leftWeight - rightWeight || rightTrust - leftTrust || leftIds.localeCompare(rightIds);
}

function assignSubset(subset: RankedProvider[], requested: string[]): CandidateSequence {
  const assignments = new Map<string, string[]>();
  for (const capability of requested) {
    const provider = [...subset].filter((entry) => entry.provider.capabilities.includes(capability)).sort(compareRankedProviders)[0];
    if (!provider) throw new RouterError("NEEDS_ROUTE_SPLIT", "Subset does not cover requested capabilities");
    assignments.set(provider.provider.id, [...(assignments.get(provider.provider.id) ?? []), capability]);
  }
  return { providers: subset.filter((entry) => assignments.has(entry.provider.id)).map((entry) => ({ ...entry, assignedCapabilities: assignments.get(entry.provider.id)! })) };
}

function orderProviders(sequence: CandidateSequence, capabilityMap: Map<string, Capability>, mode: "serial" | "independent-fanout"): CandidateSequence {
  const owner = new Map<string, string>();
  for (const entry of sequence.providers) for (const capability of entry.assignedCapabilities) owner.set(capability, entry.provider.id);
  const dependencies = new Map<string, Set<string>>(sequence.providers.map((entry) => [entry.provider.id, new Set()]));
  for (const entry of sequence.providers) for (const capabilityId of entry.assignedCapabilities) {
    for (const dependency of capabilityMap.get(capabilityId)!.dependsOn) {
      const dependencyOwner = owner.get(dependency);
      if (dependencyOwner && dependencyOwner !== entry.provider.id) dependencies.get(entry.provider.id)!.add(dependencyOwner);
    }
  }
  if (mode === "independent-fanout" && [...dependencies.values()].some((entries) => entries.size > 0)) {
    throw new RouterError("INVALID_EXECUTION_MODE", "Fan-out providers have a capability dependency");
  }
  const minStage = (entry: CandidateSequence["providers"][number]) => Math.min(...entry.assignedCapabilities.map((id) => capabilityMap.get(id)!.stage));
  if (mode === "independent-fanout") {
    sequence.providers.sort((left, right) => minStage(left) - minStage(right) || right.score - left.score || left.provider.id.localeCompare(right.provider.id));
    return sequence;
  }
  const ordered: CandidateSequence["providers"] = [];
  const remaining = new Map(sequence.providers.map((entry) => [entry.provider.id, entry]));
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((entry) => [...dependencies.get(entry.provider.id)!].every((id) => !remaining.has(id)));
    if (ready.length === 0) throw new RouterError("INVALID_CAPABILITY_GRAPH", "Provider dependency cycle");
    ready.sort((left, right) => minStage(left) - minStage(right) || right.score - left.score || left.provider.id.localeCompare(right.provider.id));
    const next = ready[0]!;
    next.assignedCapabilities.sort((left, right) => capabilityMap.get(left)!.stage - capabilityMap.get(right)!.stage || left.localeCompare(right));
    ordered.push(next); remaining.delete(next.provider.id);
  }
  return { providers: ordered };
}

export function chooseProviderSequence(rankedProviders: RankedProvider[], capabilities: Capability[], requestedCapabilities: string[], mode: "serial" | "independent-fanout"): ProviderSequence {
  const resolvedCapabilities = resolveCapabilityClosure(capabilities, requestedCapabilities);
  const capabilityMap = validateCapabilities(capabilities, resolvedCapabilities);
  if (resolvedCapabilities.length === 0) return { providers: [], truncated: false };
  const truncated = rankedProviders.length > 12;
  const candidates = rankedProviders.slice(0, 12);
  const covering: CandidateSequence[] = [];
  for (let size = 1; size <= Math.min(4, candidates.length); size += 1) {
    for (const subset of combinations(candidates, size)) {
      const supplied = new Set(subset.flatMap((entry) => entry.provider.capabilities));
      if (resolvedCapabilities.every((capability) => supplied.has(capability))) covering.push(assignSubset(subset, resolvedCapabilities));
    }
  }
  if (covering.length === 0) throw new RouterError("NEEDS_ROUTE_SPLIT", "No sequence of at most four providers covers the request");
  const unique = new Map<string, CandidateSequence>();
  for (const sequence of covering) {
    const key = sequence.providers.map((entry) => entry.provider.id).sort().join("\0");
    const current = unique.get(key);
    if (!current || compareSequences(sequence, current) < 0) unique.set(key, sequence);
  }
  const winner = [...unique.values()].sort(compareSequences)[0]!;
  return { ...orderProviders(winner, capabilityMap, mode), truncated };
}

const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
export function selectFallback(primary: Provider, rankedAlternatives: Provider[], options: { allowedSideEffects: SideEffect[]; sensitivity: Sensitivity }): { provider: Provider; approvalRequired: boolean; reasons: string[] } | null {
  for (const provider of rankedAlternatives) {
    if (TRUST_RANK[provider.trust] !== TRUST_RANK[primary.trust] || provider.health !== "healthy" || !provider.compatible) continue;
    if (!primary.capabilities.every((capability) => provider.capabilities.includes(capability))) continue;
    if (provider.sideEffects.some((effect) => !options.allowedSideEffects.includes(effect))) continue;
    if (SENSITIVITY_RANK[provider.contextMaximumSensitivity] < SENSITIVITY_RANK[options.sensitivity] || SENSITIVITY_RANK[provider.trustMaximumSensitivity] < SENSITIVITY_RANK[options.sensitivity]) continue;
    const reasons: string[] = [];
    if (provider.workflowWeight !== primary.workflowWeight) reasons.push("workflow-weight-differs");
    if (JSON.stringify([...provider.sideEffects].sort()) !== JSON.stringify([...primary.sideEffects].sort())) reasons.push("side-effects-differ");
    if ((provider.evaluationConfidence ?? 0) !== (primary.evaluationConfidence ?? 0)) reasons.push("confidence-differs");
    return { provider, approvalRequired: reasons.length > 0, reasons };
  }
  return null;
}

export interface SequenceState { policy: "stop" | "continue-independent" | "fallback"; currentIndex: number; providerIds: string[]; cancelled: boolean; fallbackApproved?: boolean }
export function advanceSequence(state: SequenceState, result: { status: "succeeded" | "partial" | "failed" | "cancelled" | "invalid" }): string | null {
  if (state.cancelled || result.status === "cancelled" || result.status === "invalid") return null;
  const next = state.providerIds[state.currentIndex + 1] ?? null;
  if (result.status === "succeeded") return next;
  if (state.policy === "continue-independent") return next;
  if (state.policy === "fallback" && state.fallbackApproved) return next;
  return null;
}

export function createCancellationPlan(activeProviderIds: string[], cancellableProviderIds: string[]): { preventSubsequent: true; cancelProviderIds: string[] } {
  const cancellable = new Set(cancellableProviderIds);
  return { preventSubsequent: true, cancelProviderIds: activeProviderIds.filter((id) => cancellable.has(id)) };
}

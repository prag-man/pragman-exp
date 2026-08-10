import type { Lane, RouteInput } from "./types.ts";

export const LANE_RANK: Record<Lane, number> = { fast: 0, standard: 1, deep: 2, operational: 3 };
const OPERATIONAL_EFFECTS = new Set(["credential-use", "destructive-action", "paid-external-action", "production-data-write", "external-account-mutation", "deployment", "live-data-write"]);

export function laneReasons(input: RouteInput): { lane: Lane; reasons: string[]; operationalTrigger: boolean } {
  const operational = input.declared_side_effects.some((effect) => OPERATIONAL_EFFECTS.has(effect)) || input.scope_systems.includes("live-infrastructure");
  if (operational) return { lane: "operational", reasons: ["operational-side-effect-or-live-infrastructure"], operationalTrigger: true };
  const independentSystems = new Set(input.scope_systems).size;
  if (independentSystems >= 2) return { lane: "deep", reasons: ["multiple-independent-systems"], operationalTrigger: false };
  if (input.estimated_sessions === "multiple") return { lane: "deep", reasons: ["multiple-estimated-sessions"], operationalTrigger: false };
  if (input.uncertainties.some((uncertainty) => uncertainty.impact === "high")) return { lane: "deep", reasons: ["high-impact-uncertainty"], operationalTrigger: false };
  if (input.task_family === "shape" && input.downstream_impact === "high" && input.reversibility === "irreversible") return { lane: "deep", reasons: ["high-impact-irreversible-shaping"], operationalTrigger: false };
  if (input.deliverable_kind !== "response-only") return { lane: "standard", reasons: ["artifact-or-change-deliverable"], operationalTrigger: false };
  if (input.declared_side_effects.length > 0) return { lane: "standard", reasons: ["declared-side-effect"], operationalTrigger: false };
  if (new Set(input.requested_capabilities).size > 1) return { lane: "standard", reasons: ["multiple-capabilities"], operationalTrigger: false };
  return { lane: "fast", reasons: ["bounded-read-only-response"], operationalTrigger: false };
}

export function deriveLane(input: RouteInput, options: { explicitLane?: Lane; prohibitLaneDecrease?: boolean } = {}): Lane {
  const derived = laneReasons(input);
  const explicit = options.explicitLane;
  if (!explicit) return derived.lane;
  if (LANE_RANK[explicit] >= LANE_RANK[derived.lane]) return explicit;
  if (derived.operationalTrigger || options.prohibitLaneDecrease) return derived.lane;
  return explicit;
}

import { effectiveSensitivity } from "./rules.ts";
import type { ApprovalRequirement, ApprovalType, Lane, RouteInput } from "./types.ts";

const EXTERNAL_ACTIONS = new Set(["external-message", "issue-write", "pull-request-write", "purchase", "external-account-mutation", "deployment", "live-data-write", "production-data-write", "paid-external-action"]);

export function deriveApprovals(input: RouteInput, lane: Lane, options: {
  ruleApprovals?: Array<Exclude<ApprovalType, "host-action">>;
  materialAssumptions?: boolean;
  unexpectedHeavyProvider?: boolean;
} = {}): ApprovalRequirement[] {
  const requirements: ApprovalRequirement[] = [];
  const add = (type: ApprovalRequirement["type"], reason: string, required = true, hostNative = false): void => {
    if (!requirements.some((entry) => entry.type === type)) requirements.push({ type, reason, required, ...(hostNative ? { hostNative: true } : {}) });
  };
  const sensitivity = effectiveSensitivity(input);
  if (input.egress_destinations.some((destination) => destination !== "local-process") && sensitivity !== "public") add("egress", "remote-egress-of-non-public-data");
  const fileMutation = input.declared_side_effects.some((effect) => effect === "project-file-write" || effect === "workspace-file-write");
  if (fileMutation) {
    if (lane === "fast" || lane === "standard") add("preview", "show-route-and-preview-before-first-write", false);
    else add("route", "file-mutation-in-deep-or-operational-lane");
  }
  const externalAction = input.declared_side_effects.some((effect) => EXTERNAL_ACTIONS.has(effect));
  if (externalAction) {
    if (lane === "operational") {
      add("route", "operational-external-action");
      add("host-action", "host-native-action-permission", true, true);
    } else add("action", "external-action");
  }
  if (input.declared_side_effects.includes("destructive-action") || input.reversibility === "irreversible") add("target-specific", "destructive-or-hard-to-reverse-action");
  if (lane === "deep" && options.materialAssumptions) add("route", "material-assumption-in-deep-lane");
  if (options.unexpectedHeavyProvider) add("route", "unexpected-heavier-provider");
  for (const approval of options.ruleApprovals ?? []) add(approval, "matched-routing-rule");
  return requirements;
}

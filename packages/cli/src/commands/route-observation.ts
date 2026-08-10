import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { createLocalBestEffortDependencies, loadEventSettings, observeSkillEvent, sha256Digest, type ObservationResult, type SkillEvent } from "../../../events/src/index.ts";
import type { HostId } from "../../../provider-registry/src/index.ts";
import type { CliArguments } from "../args.ts";
import { DEFAULT_EVENT_STATE_ROOT } from "./events.ts";

function uuidV7(): string {
  const bytes = randomBytes(16);
  let milliseconds = Date.now();
  for (let index = 5; index >= 0; index -= 1) { bytes[index] = milliseconds & 0xff; milliseconds = Math.floor(milliseconds / 256); }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function routeLifecycleEvents(input: {
  routeId: string;
  invocationId?: string;
  host: HostId;
  hostVersion?: string;
  provider: string | null;
  status: "succeeded" | "partial" | "failed";
  startedAt: Date;
  finishedAt?: Date;
}): [SkillEvent, SkillEvent] {
  const invocationId = input.invocationId ?? uuidV7();
  const finishedAt = input.finishedAt ?? new Date();
  const common = {
    schema_version: 1 as const, invocation_id: invocationId, skill_id: "pragman:router", skill_version: "1",
    skill_digest: sha256Digest({ skill_id: "pragman:router", contract: "route-v1" }), skill_type: "capability" as const,
    host: input.host, host_version: input.hostVersion ?? "unknown", model: "none", model_version: "none", harness_version: "1",
    invocation_mode: "router" as const, session_id: null, route_id: input.routeId, eval_id: null, case_id: null, trial_id: null,
    provider: input.provider, ablation_arm: "production" as const, trigger_expected: null, trigger_actual: true,
    provider_digest: input.provider ? sha256Digest({ provider: input.provider }) : null, eval_corpus_digest: null, trial_policy_digest: null,
    tool_calls: 0, retries: 0, rework_cycles: 0, verification_checks: 0, verification_passes: 0,
    observation_source: "router" as const, source_aliases: [], storage_scope: "local" as const, append_only: true as const,
  };
  return [{
    ...common, event_id: uuidV7(), timestamp: input.startedAt.toISOString(), event_type: "invoked", status: null,
    outcome_code: null, duration_ms: 0,
  }, {
    ...common, event_id: uuidV7(), timestamp: finishedAt.toISOString(), event_type: "completed", status: input.status,
    outcome_code: input.status === "succeeded" ? "route-ready" : input.status === "partial" ? "route-partial" : "route-failed",
    duration_ms: Math.max(0, finishedAt.getTime() - input.startedAt.getTime()),
  }];
}

export async function observeRouteLifecycle(arguments_: CliArguments, events: [SkillEvent, SkillEvent]): Promise<string[]> {
  try {
    const configPath = arguments_.config ? join(arguments_.config, "config.yaml") : join(homedir(), ".pragman", "config.yaml");
    const settings = await loadEventSettings(configPath);
    const dependencies = await createLocalBestEffortDependencies(arguments_.stateRoot ?? DEFAULT_EVENT_STATE_ROOT);
    const results: ObservationResult[] = [];
    for (const event of events) results.push(await observeSkillEvent(settings, event, dependencies));
    return results.flatMap((result) => result.recorded ? [] : [`EVENT_OBSERVATION_${result.reason}`]);
  } catch {
    return ["EVENT_OBSERVATION_FAILED"];
  }
}

import { readFile } from "node:fs/promises";

import { routeTask, RouterError, type RouteInput } from "../../../router/src/index.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution, CommandIo } from "./events.ts";
import { loadRuntimeProviderRegistry, projectProviderRegistry } from "./provider-support.ts";
import { resolveRouteContext } from "./route-context.ts";
import { observeRouteLifecycle, routeLifecycleEvents } from "./route-observation.ts";

const FAMILIES = new Set(["explain", "research", "shape", "prototype", "implement", "debug", "review", "analyze", "operate", "administer"]);
const DELIVERABLES = new Set(["response-only", "local-artifact", "project-change", "external-action"]);
const MODES = new Set(["serial", "independent-fanout"]);
const LEVELS = new Set(["low", "medium", "high"]);
const SENSITIVITIES = new Set(["public", "internal", "confidential", "restricted"]);

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0); }

function conflictResolutions(value: unknown): value is Record<string, string> {
  return value === undefined || (object(value) && Object.entries(value).every(([path, choice]) => (
    path.startsWith("/") && path.length <= 256 && !path.includes("..")
      && typeof choice === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(choice)
  )));
}

function assertRouteInput(value: unknown): asserts value is RouteInput {
  if (!object(value)) throw new RouterError("INVALID_INPUT", "Route input must be an object");
  const required = ["request", "task_family", "desired_outcome", "deliverable_kind", "execution_mode", "declared_side_effects", "data_inputs", "egress_destinations", "urgency", "uncertainties", "scope_systems", "estimated_sessions", "downstream_impact", "reversibility", "requested_capabilities", "workspace", "project"];
  const allowed = [...required, "resolved_secondary_conflicts"];
  if (!required.every((field) => field in value) || Object.keys(value).some((field) => !allowed.includes(field))) throw new RouterError("INVALID_INPUT", "Route input fields are incomplete or unknown");
  const valid = typeof value.request === "string" && value.request.trim().length > 0 && value.request.length <= 20_000
    && FAMILIES.has(String(value.task_family)) && typeof value.desired_outcome === "string" && value.desired_outcome.trim().length > 0 && value.desired_outcome.length <= 2_000
    && DELIVERABLES.has(String(value.deliverable_kind)) && MODES.has(String(value.execution_mode))
    && strings(value.declared_side_effects) && strings(value.egress_destinations) && strings(value.scope_systems) && strings(value.requested_capabilities)
    && (value.urgency === "normal" || value.urgency === "urgent") && (value.estimated_sessions === "one" || value.estimated_sessions === "multiple" || value.estimated_sessions === "unknown")
    && LEVELS.has(String(value.downstream_impact)) && (value.reversibility === "reversible" || value.reversibility === "costly" || value.reversibility === "irreversible")
    && (value.workspace === null || typeof value.workspace === "string") && (value.project === null || typeof value.project === "string")
    && Array.isArray(value.data_inputs) && value.data_inputs.every((entry) => object(entry) && typeof entry.id === "string" && typeof entry.source_alias === "string" && typeof entry.category === "string" && SENSITIVITIES.has(String(entry.sensitivity)))
    && Array.isArray(value.uncertainties) && value.uncertainties.every((entry) => object(entry) && typeof entry.id === "string" && typeof entry.description === "string" && LEVELS.has(String(entry.impact)))
    && conflictResolutions(value.resolved_secondary_conflicts);
  if (!valid) throw new RouterError("INVALID_INPUT", "Route input contains invalid values");
}

async function readInput(arguments_: CliArguments, io: CommandIo): Promise<unknown> {
  const raw = arguments_.file ? await readFile(arguments_.file, "utf8") : await io.readStdin();
  if (!raw.trim()) throw new RouterError("NEEDS_INPUT", "Route input JSON is required");
  try { return JSON.parse(raw) as unknown; } catch { throw new RouterError("INVALID_INPUT", "Route input must be valid JSON"); }
}

function failure(error: unknown): CommandExecution {
  const command = "route";
  const code = error instanceof RouterError ? error.code : typeof error === "object" && error !== null && "code" in error ? String(error.code) : "INTERNAL";
  const message = error instanceof Error ? error.message : "Routing failed";
  const invalidConfiguration = new Set(["INVALID_CONFIGURATION", "INCOMPATIBLE_VERSION", "INVALID_PATH", "WORKSPACE_MISMATCH"]);
  const exitCode = code === "NEEDS_INPUT" || code === "MISSING_PROVIDER" ? EXIT_CODES.needsInput
    : code === "INVALID_INPUT" || code === "PROVIDER_REGISTRY_INVALID" || invalidConfiguration.has(code) ? EXIT_CODES.invalid
      : code === "INTERNAL" ? EXIT_CODES.internal : EXIT_CODES.denied;
  return { exitCode, envelope: errorEnvelope(command, code, message), human: message, stderr: true };
}

export async function executeRouteCommand(arguments_: CliArguments, io: CommandIo): Promise<CommandExecution> {
  const startedAt = new Date();
  try {
    const input = await readInput(arguments_, io);
    assertRouteInput(input);
    const resolutions = (input as RouteInput & { resolved_secondary_conflicts?: Record<string, string> }).resolved_secondary_conflicts ?? {};
    const { registry, host, warnings, personalPreferences } = await loadRuntimeProviderRegistry(arguments_);
    const context = await resolveRouteContext(arguments_, input);
    const requested = registry.validateRequestedCapabilities(context.input.requested_capabilities);
    if (!requested.ok) throw new RouterError(requested.code, `Requested capabilities are invalid: ${requested.capabilities.join(", ")}`);
    const projected = projectProviderRegistry(registry);
    const result = routeTask(context.input, {
      ...projected,
      activeHost: host,
      allowedSideEffects: context.input.declared_side_effects,
      projectLinks: context.projectLinks,
      secondaryConflicts: context.secondaryConflicts,
      routingRules: context.routingRules,
      projectPreferences: context.projectPreferences,
      workspacePreferences: context.workspacePreferences,
      personalPreferences: [...context.personalProfilePreferences, ...personalPreferences],
      prohibitedProviders: context.personalProfileAvoidances,
      resolvedSecondaryConflicts: resolutions,
      assumptions: Object.entries(resolutions).sort(([left], [right]) => left.localeCompare(right))
        .map(([path, workspace]) => `resolved-secondary-conflict:${path}:${workspace}`),
      ...(context.preferredWorkflowWeight ? { preferredWorkflowWeight: context.preferredWorkflowWeight } : {}),
      ...(context.explicitLane ? { explicitLane: context.explicitLane } : {}),
      ...(arguments_.provider ? { explicitProviders: [arguments_.provider] } : {}),
    });
    const routedResult = { ...result, execution_status: "not-started" as const };
    const resultWithContext = context.evidence ? { ...routedResult, context_policy_evidence: context.evidence } : routedResult;
    if (result.status !== "ready" && result.status !== "existing") {
      const code = result.code;
      const human = result.requiredInput ?? result.recommendations?.join(", ") ?? code;
      return { exitCode: EXIT_CODES.needsInput, envelope: errorEnvelope("route", code, human, resultWithContext), human, stderr: true };
    }
    const observationWarnings = await observeRouteLifecycle(arguments_, routeLifecycleEvents({
      routeId: result.contract.route_id, host, ...(arguments_.hostVersion ? { hostVersion: arguments_.hostVersion } : {}),
      provider: result.contract.providers[0] ?? null, startedAt,
    }));
    return { exitCode: EXIT_CODES.success, envelope: successEnvelope("route", resultWithContext, [...warnings, ...observationWarnings]), human: `${result.contract.lane} route: ${result.contract.providers.join(" → ") || "native response"}.`, stderr: false };
  } catch (error) {
    return failure(error);
  }
}

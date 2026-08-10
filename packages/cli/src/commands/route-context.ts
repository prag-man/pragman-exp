import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";

import routingSchema from "../../../config/schemas/routing.schema.json" with { type: "json" };
import {
  ConfigError,
  loadConfigurationContext,
  mergeConfiguration,
  normalizeAbsolutePath,
  resolveContainedPath,
  type FieldProvenance,
  type JsonObject,
  type JsonValue,
  type LoadedConfigurationContext,
} from "../../../config/src/index.ts";
import type { Lane, RouteInput, RoutingRule, RuleLayer, Sensitivity } from "../../../router/src/index.ts";
import type { CliArguments } from "../args.ts";

interface RoutingConfiguration extends JsonObject {
  schema_version: 1;
  defaults: JsonObject;
  rules: JsonObject[];
}

export interface RouteContextPolicyEvidence {
  source_bodies_loaded: false;
  sources: Array<{ source_alias: string; sensitivity: Sensitivity }>;
  provenance: FieldProvenance | null;
  layers: {
    personal: true;
    primary_workspace: string | null;
    project: string | null;
    additional_workspaces: string[];
  };
  conflict_paths: string[];
}

export interface RouteContextResolution {
  input: RouteInput;
  projectLinks: Record<string, string | null>;
  secondaryConflicts: Array<{ path: string; values: unknown[] }>;
  routingRules: RoutingRule[];
  projectPreferences: string[];
  workspacePreferences: string[];
  explicitLane?: Lane;
  evidence: RouteContextPolicyEvidence | null;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: false, removeAdditional: false, coerceTypes: false });
const validateRouting = ajv.compile(routingSchema) as ValidateFunction<RoutingConfiguration>;
const SENSITIVITIES = new Set<Sensitivity>(["public", "internal", "confidential", "restricted"]);

function object(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function routingIssues(): string[] {
  return (validateRouting.errors ?? []).map((issue) => `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}`);
}

async function loadOptionalRouting(root: string, relativePath: string): Promise<RoutingConfiguration | null> {
  const path = resolveContainedPath(normalizeAbsolutePath(root), relativePath);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ConfigError("INVALID_PATH", "Routing configuration must be a regular file");
    }
    let value: unknown;
    try {
      value = parse(await readFile(path, "utf8"), { uniqueKeys: true });
    } catch {
      throw new ConfigError("INVALID_CONFIGURATION", "Routing configuration is not valid YAML");
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const version = (value as Record<string, unknown>).schema_version;
      if (typeof version === "number" && version > 1) {
        throw new ConfigError("INCOMPATIBLE_VERSION", `Routing schema version ${version} is newer than supported version 1`, { supportedVersion: 1 });
      }
    }
    if (!validateRouting(value)) {
      throw new ConfigError("INVALID_CONFIGURATION", "Routing configuration failed schema validation", { issues: routingIssues() });
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function providers(configuration: RoutingConfiguration | null): string[] {
  const selected = configuration?.defaults.providers;
  return Array.isArray(selected) ? selected.filter((value): value is string => typeof value === "string") : [];
}

function routerLayer(layer: string): RuleLayer {
  if (layer === "primary-workspace") return "workspace";
  if (layer === "project" || layer === "personal" || layer === "explicit" || layer === "additional-workspace") return layer;
  return "personal";
}

function routingRule(layer: RuleLayer, value: JsonObject & { id: string }): RoutingRule {
  return {
    id: value.id,
    layer,
    priority: typeof value.priority === "number" ? value.priority : 0,
    when: value.when as RoutingRule["when"],
    action: value.action as RoutingRule["action"],
  };
}

function contextSources(value: JsonValue | undefined): Array<{ source_alias: string; sensitivity: Sensitivity }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((source) => {
    if (!object(source) || typeof source.id !== "string") return [];
    const sensitivity = typeof source.sensitivity === "string" && SENSITIVITIES.has(source.sensitivity as Sensitivity)
      ? source.sensitivity as Sensitivity
      : "internal";
    return [{ source_alias: `context-source:${source.id}`, sensitivity }];
  });
}

function withContextInputs(input: RouteInput, sources: RouteContextPolicyEvidence["sources"]): RouteInput {
  if (sources.length === 0) return input;
  return {
    ...input,
    data_inputs: [
      ...input.data_inputs,
      ...sources.map((source, index) => ({
        id: `route-context-${index + 1}`,
        source_alias: source.source_alias,
        category: "workspace-context",
        sensitivity: source.sensitivity,
      })),
    ],
  };
}

async function selectedConfiguration(arguments_: CliArguments, input: RouteInput): Promise<LoadedConfigurationContext | null> {
  if (arguments_.workspace && input.workspace && arguments_.workspace !== input.workspace) {
    throw new ConfigError("WORKSPACE_MISMATCH", "Selected workspace does not match the route input workspace", {
      selected: arguments_.workspace,
      requested: input.workspace,
    });
  }
  if (input.project && !arguments_.projectRoot) return null;
  const workspaceId = input.workspace ?? arguments_.workspace;
  if (!arguments_.projectRoot && !workspaceId) return null;
  const personalRoot = normalizeAbsolutePath(arguments_.config ?? join(homedir(), ".pragman"));
  return loadConfigurationContext({
    personalRoot,
    ...(workspaceId ? { workspaceId } : {}),
    ...(arguments_.projectRoot ? { projectRoot: arguments_.projectRoot } : {}),
  });
}

export async function resolveRouteContext(arguments_: CliArguments, input: RouteInput): Promise<RouteContextResolution> {
  const context = await selectedConfiguration(arguments_, input);
  if (!context) {
    return {
      input,
      projectLinks: {},
      secondaryConflicts: [],
      routingRules: [],
      projectPreferences: [],
      workspacePreferences: [],
      evidence: null,
    };
  }
  if (input.project && context.project?.project_id !== input.project) {
    throw new ConfigError("INVALID_CONFIGURATION", "Selected project root does not match the route input project", {
      selected: context.project?.project_id ?? null,
      requested: input.project,
    });
  }

  const normalizedInput: RouteInput = {
    ...input,
    workspace: input.workspace ?? (context.mode === "workspace-only" ? context.primaryWorkspace?.workspace_id ?? null : null),
    project: input.project ?? context.project?.project_id ?? null,
  };
  const mergedContext = mergeConfiguration({
    personal: context.personal,
    ...(context.primaryWorkspace ? { primaryWorkspace: context.primaryWorkspace } : {}),
    ...(context.project ? { project: context.project } : {}),
    additionalWorkspaces: context.additionalWorkspaces.map((workspace) => ({ workspaceId: workspace.workspace_id, value: workspace })),
  });

  const personalLane = object(context.personal.routing) && typeof context.personal.routing.default_lane === "string"
    ? context.personal.routing.default_lane
    : "adaptive";
  const [projectRouting, workspaceRouting, ...additionalRouting] = await Promise.all([
    context.project ? loadOptionalRouting(context.project.root, ".pragman/routing.yaml") : Promise.resolve(null),
    context.primaryWorkspace ? loadOptionalRouting(context.primaryWorkspace.root, "routing.yaml") : Promise.resolve(null),
    ...context.additionalWorkspaces.map((workspace) => loadOptionalRouting(workspace.root, "routing.yaml")),
  ]);
  const mergedRouting = mergeConfiguration({
    personal: { defaults: { lane: personalLane } },
    ...(projectRouting ? { project: projectRouting } : {}),
    ...(workspaceRouting ? { primaryWorkspace: workspaceRouting } : {}),
    additionalWorkspaces: additionalRouting.flatMap((routing, index) => routing
      ? [{ workspaceId: context.additionalWorkspaces[index]!.workspace_id, value: routing }]
      : []),
  });
  const secondaryConflicts = [...mergedContext.additionalWorkspaceConflicts, ...mergedRouting.additionalWorkspaceConflicts]
    .map((conflict) => ({ path: conflict.path, values: conflict.values.map((entry) => ({ workspaceId: entry.workspaceId, value: entry.value })) }));
  const rules = [
    ...mergedRouting.routingRules.map((entry) => routingRule(routerLayer(entry.layer), entry.rule)),
    ...mergedRouting.additionalRoutingCandidates.map((entry) => routingRule("additional-workspace", entry.rule)),
  ];
  const sources = contextSources(mergedContext.value.context_sources);
  const evidence: RouteContextPolicyEvidence = {
    source_bodies_loaded: false,
    sources,
    provenance: mergedContext.provenance["/context_sources"] ?? null,
    layers: {
      personal: true,
      primary_workspace: context.primaryWorkspace?.workspace_id ?? null,
      project: context.project?.project_id ?? null,
      additional_workspaces: context.additionalWorkspaces.map((workspace) => workspace.workspace_id),
    },
    conflict_paths: [...new Set(secondaryConflicts.map((conflict) => conflict.path))].sort(),
  };
  const lane = object(mergedRouting.value.defaults) ? mergedRouting.value.defaults.lane : undefined;
  return {
    input: withContextInputs(normalizedInput, sources),
    projectLinks: context.project ? { [context.project.project_id]: context.project.workspace } : {},
    secondaryConflicts,
    routingRules: rules,
    projectPreferences: providers(projectRouting),
    workspacePreferences: providers(workspaceRouting),
    ...(lane === "fast" || lane === "standard" || lane === "deep" || lane === "operational" ? { explicitLane: lane } : {}),
    evidence,
  };
}

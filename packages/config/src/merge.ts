import type {
  AdditionalRoutingCandidate,
  AdditionalWorkspaceConflict,
  FieldProvenance,
  JsonObject,
  JsonValue,
  MergeConfigurationInput,
  MergeConfigurationResult,
  PrimaryLayerName,
  ProvenanceContributor,
  ResolvedRoutingRule,
} from "./types.ts";

const PRIMARY_ORDER: Array<{ name: PrimaryLayerName; input: keyof MergeConfigurationInput }> = [
  { name: "explicit", input: "explicit" },
  { name: "project", input: "project" },
  { name: "primary-workspace", input: "primaryWorkspace" },
  { name: "personal", input: "personal" },
  { name: "defaults", input: "defaults" },
];

const ORDERED_SET_FIELDS = new Set(["prohibitions", "require_capabilities", "context_sources"]);
const ADDITIONAL_IGNORED_FIELDS = new Set(["schema_version", "workspace_id", "name", "root", "description", "context_sources", "rules"]);

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointer(parent: string, key: string): string {
  const encoded = key.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${parent}/${encoded}`;
}

function canonicalId(value: JsonValue): string {
  if (typeof value === "string") return `string:${value}`;
  if (isObject(value) && typeof value.id === "string") return `id:${value.id}`;
  return `json:${JSON.stringify(value, Object.keys(isObject(value) ? value : {}).sort())}`;
}

function collectOrderedSet(
  values: Array<{ layer: PrimaryLayerName; value: JsonValue }>,
): { value: JsonValue[]; contributors: ProvenanceContributor[] } {
  const result: JsonValue[] = [];
  const seen = new Set<string>();
  const contributors: ProvenanceContributor[] = [];
  for (const entry of values) {
    if (!Array.isArray(entry.value) || entry.value.length === 0) continue;
    contributors.push({ layer: entry.layer });
    for (const item of entry.value) {
      const id = canonicalId(item);
      if (!seen.has(id)) {
        seen.add(id);
        result.push(item);
      }
    }
  }
  return { value: result, contributors };
}

function resolveNode(
  path: string,
  key: string,
  values: Array<{ layer: PrimaryLayerName; value: JsonValue }>,
  provenance: Record<string, FieldProvenance>,
): JsonValue | undefined {
  if (values.length === 0) return undefined;
  if (ORDERED_SET_FIELDS.has(key)) {
    const merged = collectOrderedSet(values);
    provenance[path] = {
      layer: merged.contributors[0]?.layer ?? values[0]!.layer,
      contributors: merged.contributors,
    };
    return merged.value;
  }
  if (values.every((entry) => isObject(entry.value))) {
    const keys = new Set<string>();
    for (const entry of values) for (const childKey of Object.keys(entry.value as JsonObject)) keys.add(childKey);
    const result: JsonObject = {};
    for (const childKey of keys) {
      const childValues = values.flatMap((entry) => {
        const value = (entry.value as JsonObject)[childKey];
        return value === undefined ? [] : [{ layer: entry.layer, value }];
      });
      const resolved = resolveNode(pointer(path, childKey), childKey, childValues, provenance);
      if (resolved !== undefined) result[childKey] = resolved;
    }
    return result;
  }
  provenance[path] = { layer: values[0]!.layer };
  return values[0]!.value;
}

function asRules(value: JsonObject | undefined): Array<JsonObject & { id: string }> {
  const rules = value?.rules;
  if (!Array.isArray(rules)) return [];
  return rules.filter((rule): rule is JsonObject & { id: string } => isObject(rule) && typeof rule.id === "string");
}

function priority(rule: JsonObject): number {
  return typeof rule.priority === "number" ? rule.priority : 0;
}

function collectScalarFacts(value: JsonObject, parent = ""): Map<string, JsonValue> {
  const facts = new Map<string, JsonValue>();
  for (const [key, child] of Object.entries(value)) {
    if (!parent && ADDITIONAL_IGNORED_FIELDS.has(key)) continue;
    const path = pointer(parent, key);
    if (isObject(child)) {
      for (const [nestedPath, nestedValue] of collectScalarFacts(child, path)) facts.set(nestedPath, nestedValue);
    } else if (!Array.isArray(child)) {
      facts.set(path, child);
    }
  }
  return facts;
}

export function mergeConfiguration(input: MergeConfigurationInput): MergeConfigurationResult {
  const layers = PRIMARY_ORDER.flatMap(({ name, input: inputKey }) => {
    const value = input[inputKey];
    return isObject(value as JsonValue | undefined) ? [{ name, value: value as JsonObject }] : [];
  });
  const provenance: Record<string, FieldProvenance> = {};
  const rootKeys = new Set<string>();
  for (const layer of layers) for (const key of Object.keys(layer.value)) rootKeys.add(key);
  const value: JsonObject = {};
  for (const key of rootKeys) {
    const values = layers.flatMap((layer) => {
      const child = layer.value[key];
      return child === undefined ? [] : [{ layer: layer.name, value: child }];
    });
    const resolved = resolveNode(pointer("", key), key, values, provenance);
    if (resolved !== undefined) value[key] = resolved;
  }

  const routingRules: ResolvedRoutingRule[] = layers.flatMap((layer) =>
    asRules(layer.value).map((rule) => ({ layer: layer.name, rule })),
  );
  routingRules.sort((left, right) => {
    const layerDifference = PRIMARY_ORDER.findIndex((entry) => entry.name === left.layer) - PRIMARY_ORDER.findIndex((entry) => entry.name === right.layer);
    return layerDifference || priority(right.rule) - priority(left.rule) || left.rule.id.localeCompare(right.rule.id);
  });

  const additionals = input.additionalWorkspaces ?? [];
  const additionalRoutingCandidates: AdditionalRoutingCandidate[] = additionals.flatMap((workspace) =>
    asRules(workspace.value).map((rule) => ({ workspaceId: workspace.workspaceId, advisory: true as const, rule })),
  );
  const factValues = new Map<string, Array<{ workspaceId: string; value: JsonValue }>>();
  for (const workspace of additionals) {
    for (const [path, factValue] of collectScalarFacts(workspace.value)) {
      const entries = factValues.get(path) ?? [];
      entries.push({ workspaceId: workspace.workspaceId, value: factValue });
      factValues.set(path, entries);
    }
  }
  const additionalWorkspaceConflicts: AdditionalWorkspaceConflict[] = [];
  for (const [path, values] of factValues) {
    if (values.length > 1 && new Set(values.map((entry) => JSON.stringify(entry.value))).size > 1) {
      additionalWorkspaceConflicts.push({ path, values });
    }
  }

  const existingContexts = Array.isArray(value.context_sources) ? value.context_sources : [];
  const seenContexts = new Set(existingContexts.map(canonicalId));
  const additionalContributors: ProvenanceContributor[] = [];
  for (const workspace of additionals) {
    const contexts = workspace.value.context_sources;
    if (!Array.isArray(contexts) || contexts.length === 0) continue;
    additionalContributors.push({ layer: "additional-workspace", sourceId: workspace.workspaceId });
    for (const context of contexts) {
      const id = canonicalId(context);
      if (!seenContexts.has(id)) {
        seenContexts.add(id);
        existingContexts.push(context);
      }
    }
  }
  if (existingContexts.length > 0) value.context_sources = existingContexts;
  if (additionalContributors.length > 0) {
    const current = provenance["/context_sources"];
    provenance["/context_sources"] = {
      layer: current?.layer ?? "additional-workspace",
      contributors: [...(current?.contributors ?? []), ...additionalContributors],
    };
  }

  return { value, provenance, additionalWorkspaceConflicts, routingRules, additionalRoutingCandidates };
}

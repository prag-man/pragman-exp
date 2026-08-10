import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";

import type {
  CapabilityDefinition,
  CreateProviderRegistryInput,
  HealthState,
  HostId,
  LoadProviderRegistryInput,
  ProviderDefinition,
  ProviderDiscovery,
  ProviderHealthSnapshot,
  ProviderRegistryIssue,
  ProviderRegistryStatus,
  RequestedCapabilityValidation,
  TrustTier,
} from "./types.ts";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROVIDER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TRUST = new Set<TrustTier>(["bundled", "curated", "workspace-approved", "discovered"]);
const HOSTS = new Set<HostId>(["codex", "claude-code", "cursor"]);
const SENSITIVITIES = new Set(["public", "internal", "confidential", "restricted"]);
const CONTEXT_CLASSES = new Set(["task-contract", "context-summary", "redacted-excerpt"]);
const SIDE_EFFECTS = new Set([
  "read-files", "run-commands", "project-file-write", "remote-egress", "external-message",
  "issue-write", "pull-request-write", "purchase", "external-account-mutation", "deploy",
  "production-data-write", "credential-access", "destructive",
]);
const WORKFLOW_WEIGHTS = new Set(["light", "standard", "heavy"]);
const CAPABILITY_FIELDS = new Set(["schema_version", "id", "stage", "depends_on", "result_contract", "description", "incompatible_with"]);
const PROVIDER_FIELDS = new Set([
  "schema_version", "id", "source", "source_version", "trust", "capabilities", "host_support", "invoke",
  "context_policy", "side_effects", "workflow_weight", "result_contract", "requires", "strengths", "best_for",
  "avoid_when", "compatibility", "evaluation_confidence",
]);

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function stringArray(value: unknown, pattern: RegExp = ID): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && pattern.test(entry));
}

function unknownField(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  return Object.keys(value).find((field) => !allowed.has(field)) ?? null;
}

function issue(code: ProviderRegistryIssue["code"], path: string, message: string): ProviderRegistryIssue {
  return { code, path, message };
}

function validateCapability(value: unknown, index: number): ProviderRegistryIssue[] {
  const path = `capabilities[${index}]`;
  if (!plain(value)) return [issue("INVALID_DOCUMENT", path, "Capability must be an object")];
  const extra = unknownField(value, CAPABILITY_FIELDS);
  if (extra) return [issue("UNKNOWN_FIELD", `${path}.${extra}`, "Unknown capability field")];
  const valid = value.schema_version === 1
    && typeof value.id === "string" && ID.test(value.id)
    && Number.isSafeInteger(value.stage) && (value.stage as number) >= 0 && (value.stage as number) <= 100
    && stringArray(value.depends_on)
    && typeof value.result_contract === "string" && ID.test(value.result_contract)
    && (value.description === undefined || (typeof value.description === "string" && value.description.length <= 512))
    && (value.incompatible_with === undefined || stringArray(value.incompatible_with));
  return valid ? [] : [issue("INVALID_FIELD", path, "Capability fields are invalid")];
}

function validInvocation(value: unknown): boolean {
  if (!plain(value) || typeof value.kind !== "string") return false;
  if (value.kind === "native-skill") {
    return unknownField(value, new Set(["kind", "skill_id"])) === null
      && typeof value.skill_id === "string" && PROVIDER_ID.test(value.skill_id);
  }
  if (value.kind === "prompt-handoff") {
    return unknownField(value, new Set(["kind", "skill_id", "prompt"])) === null
      && typeof value.skill_id === "string" && PROVIDER_ID.test(value.skill_id)
      && typeof value.prompt === "string" && value.prompt.length > 0 && value.prompt.length <= 2_000;
  }
  if (value.kind === "cli") {
    return unknownField(value, new Set(["kind", "executable", "arguments"])) === null
      && value.executable === "pragman"
      && Array.isArray(value.arguments) && value.arguments.length <= 32
      && value.arguments.every((entry) => typeof entry === "string" && entry.length <= 128 && !/[;&|`$<>\n\r]/.test(entry));
  }
  return value.kind === "manual"
    && unknownField(value, new Set(["kind", "instructions"])) === null
    && Array.isArray(value.instructions) && value.instructions.length > 0 && value.instructions.length <= 12
    && value.instructions.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 1_000);
}

function validContextPolicy(value: unknown): boolean {
  return plain(value)
    && unknownField(value, new Set(["accepted_classes", "maximum_sensitivity", "accepts_redacted_excerpts"])) === null
    && Array.isArray(value.accepted_classes) && value.accepted_classes.length > 0
    && value.accepted_classes.every((entry) => CONTEXT_CLASSES.has(String(entry)))
    && SENSITIVITIES.has(String(value.maximum_sensitivity))
    && typeof value.accepts_redacted_excerpts === "boolean";
}

function validCompatibility(value: unknown): boolean {
  if (value === undefined) return true;
  if (!plain(value) || unknownField(value, new Set(["source_version", "hosts"])) !== null) return false;
  if (value.source_version !== undefined && typeof value.source_version !== "string") return false;
  if (value.hosts === undefined) return true;
  return plain(value.hosts) && Object.entries(value.hosts).every(([host, range]) => HOSTS.has(host as HostId) && typeof range === "string");
}

function validateProvider(value: unknown, index: number): ProviderRegistryIssue[] {
  const path = `providers[${index}]`;
  if (!plain(value)) return [issue("INVALID_DOCUMENT", path, "Provider must be an object")];
  const extra = unknownField(value, PROVIDER_FIELDS);
  if (extra) return [issue("UNKNOWN_FIELD", `${path}.${extra}`, "Unknown provider field")];
  if (!TRUST.has(value.trust as TrustTier)) return [issue("INVALID_TRUST", `${path}.trust`, "Invalid provider trust tier")];
  if (plain(value.invoke) && value.invoke.kind === "cli" && value.invoke.executable !== "pragman") {
    return [issue("UNSAFE_EXECUTABLE", `${path}.invoke.executable`, "Only the Pragman-owned executable is allowed")];
  }
  const optionalLists = ["requires", "strengths", "best_for", "avoid_when"];
  const valid = value.schema_version === 1
    && typeof value.id === "string" && PROVIDER_ID.test(value.id)
    && typeof value.source === "string" && SOURCE.test(value.source)
    && typeof value.source_version === "string" && value.source_version.length > 0 && value.source_version.length <= 128
    && stringArray(value.capabilities)
    && Array.isArray(value.host_support) && value.host_support.length > 0 && value.host_support.every((entry) => HOSTS.has(entry as HostId))
    && validInvocation(value.invoke)
    && validContextPolicy(value.context_policy)
    && Array.isArray(value.side_effects) && value.side_effects.every((entry) => SIDE_EFFECTS.has(String(entry)))
    && WORKFLOW_WEIGHTS.has(String(value.workflow_weight))
    && typeof value.result_contract === "string" && ID.test(value.result_contract)
    && optionalLists.every((field) => value[field] === undefined || stringArray(value[field], /^[a-z0-9][a-z0-9:.-]*$/))
    && validCompatibility(value.compatibility)
    && (value.evaluation_confidence === undefined || (typeof value.evaluation_confidence === "number" && value.evaluation_confidence >= 0 && value.evaluation_confidence <= 1));
  return valid ? [] : [issue("INVALID_FIELD", path, "Provider fields are invalid")];
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(clause);
    if (!match) return false;
    const target = parseVersion(match[2]!);
    if (!target) return false;
    const compared = compareVersion(parsed, target);
    if (match[1] === ">=") return compared >= 0;
    if (match[1] === "<=") return compared <= 0;
    if (match[1] === ">") return compared > 0;
    if (match[1] === "<") return compared < 0;
    return compared === 0;
  });
}

function trustRank(trust: TrustTier): number {
  return { bundled: 4, curated: 3, "workspace-approved": 2, discovered: 1 }[trust];
}

function scopeRank(scope: ProviderDiscovery["install_scope"]): number {
  return { project: 3, user: 2, global: 1 }[scope];
}

export class ProviderRegistryValidationError extends Error {
  readonly code = "PROVIDER_REGISTRY_INVALID";

  constructor(readonly issues: ProviderRegistryIssue[]) {
    super(`Provider registry is invalid: ${issues.map((entry) => `${entry.code} at ${entry.path}`).join(", ")}`);
  }
}

function validateGraph(capabilities: readonly CapabilityDefinition[], providers: readonly ProviderDefinition[]): ProviderRegistryIssue[] {
  const issues: ProviderRegistryIssue[] = [];
  const byCapability = new Map<string, CapabilityDefinition>();
  for (const [index, definition] of capabilities.entries()) {
    if (byCapability.has(definition.id)) issues.push(issue("DUPLICATE_CAPABILITY", `capabilities[${index}].id`, definition.id));
    else byCapability.set(definition.id, definition);
  }
  const byProvider = new Set<string>();
  for (const [index, definition] of providers.entries()) {
    if (byProvider.has(definition.id)) issues.push(issue("DUPLICATE_PROVIDER", `providers[${index}].id`, definition.id));
    byProvider.add(definition.id);
    for (const id of definition.capabilities) if (!byCapability.has(id)) {
      issues.push(issue("MISSING_CAPABILITY", `providers[${index}].capabilities`, id));
    }
  }
  for (const [index, definition] of capabilities.entries()) {
    for (const dependency of definition.depends_on) if (!byCapability.has(dependency)) {
      issues.push(issue("MISSING_DEPENDENCY", `capabilities[${index}].depends_on`, dependency));
    }
    for (const incompatible of definition.incompatible_with ?? []) if (!byCapability.has(incompatible) || incompatible === definition.id) {
      issues.push(issue("INVALID_INCOMPATIBILITY", `capabilities[${index}].incompatible_with`, incompatible));
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = (byCapability.get(id)?.depends_on ?? []).some(visit);
    visiting.delete(id);
    visited.add(id);
    return cyclic;
  };
  for (const id of byCapability.keys()) if (visit(id)) {
    issues.push(issue("CAPABILITY_CYCLE", "capabilities", id));
    break;
  }
  return issues;
}

function providerDiscoveries(provider: ProviderDefinition, discoveries: readonly ProviderDiscovery[]): ProviderDiscovery[] {
  const skillId = provider.invoke.kind === "native-skill" || provider.invoke.kind === "prompt-handoff"
    ? provider.invoke.skill_id
    : provider.id;
  const unique = new Map<string, ProviderDiscovery>();
  for (const discovery of discoveries) {
    if (discovery.source !== provider.source || discovery.skill_id !== skillId) continue;
    const key = discovery.digest;
    const previous = unique.get(key);
    if (!previous || scopeRank(discovery.install_scope) > scopeRank(previous.install_scope)) unique.set(key, discovery);
  }
  return [...unique.values()].sort((left, right) => scopeRank(right.install_scope) - scopeRank(left.install_scope) || left.path_alias.localeCompare(right.path_alias));
}

function statusFor(
  provider: ProviderDefinition,
  discoveries: readonly ProviderDiscovery[],
  previous: ProviderHealthSnapshot | undefined,
  host: HostId | undefined,
  hostVersion: string | undefined,
): ProviderRegistryStatus {
  const empty = (health: HealthState, reason: ProviderRegistryStatus["reason"]): ProviderRegistryStatus => ({
    health, reason, selected_path_alias: null, selected_digest: null, shadowed_path_aliases: [],
  });
  if (host && !provider.host_support.includes(host)) return empty("incompatible", "HOST_UNSUPPORTED");
  const hostRange = host ? provider.compatibility?.hosts?.[host] : undefined;
  if (hostRange && (!hostVersion || !satisfiesVersionRange(hostVersion, hostRange))) return empty("incompatible", "HOST_VERSION_UNSUPPORTED");
  if (provider.invoke.kind === "manual") return empty("degraded", "MANUAL_HANDOFF");
  const candidates = providerDiscoveries(provider, discoveries);
  if (candidates.length === 0) {
    return provider.invoke.kind === "prompt-handoff"
      ? empty("degraded", "PROMPT_HANDOFF")
      : provider.invoke.kind === "cli"
        ? empty("healthy", null)
        : empty("missing", "NOT_INSTALLED");
  }
  const selected = candidates[0]!;
  const selectedTrust = selected.trust ?? provider.trust;
  const conflict = candidates.slice(1).some((candidate) =>
    scopeRank(selected.install_scope) === scopeRank(candidate.install_scope)
    || trustRank(selectedTrust) < trustRank(candidate.trust ?? provider.trust));
  if (conflict) return {
    health: "conflict", reason: "SHADOW_CONFLICT", selected_path_alias: null, selected_digest: null,
    shadowed_path_aliases: [],
  };
  const sourceRange = provider.compatibility?.source_version;
  if (sourceRange && !satisfiesVersionRange(selected.version, sourceRange)) return {
    health: "incompatible", reason: "SOURCE_VERSION_UNSUPPORTED", selected_path_alias: selected.path_alias,
    selected_digest: selected.digest, shadowed_path_aliases: candidates.slice(1).map((entry) => entry.path_alias).sort(),
  };
  if (previous?.health === "quarantined") return {
    health: "quarantined", reason: "QUARANTINED", selected_path_alias: selected.path_alias,
    selected_digest: selected.digest, shadowed_path_aliases: candidates.slice(1).map((entry) => entry.path_alias).sort(),
  };
  if (previous && previous.digest !== selected.digest) return {
    health: "unknown", reason: "DIGEST_DRIFT", selected_path_alias: selected.path_alias,
    selected_digest: selected.digest, shadowed_path_aliases: candidates.slice(1).map((entry) => entry.path_alias).sort(),
  };
  if (previous && previous.version !== selected.version) return {
    health: "unknown", reason: "VERSION_DRIFT", selected_path_alias: selected.path_alias,
    selected_digest: selected.digest, shadowed_path_aliases: candidates.slice(1).map((entry) => entry.path_alias).sort(),
  };
  return {
    health: "healthy", reason: null, selected_path_alias: selected.path_alias, selected_digest: selected.digest,
    shadowed_path_aliases: candidates.slice(1).map((entry) => entry.path_alias).sort(),
  };
}

export class ProviderRegistry {
  readonly #capabilities: Map<string, CapabilityDefinition>;
  readonly #providers: Map<string, ProviderDefinition>;
  readonly #statuses: Map<string, ProviderRegistryStatus>;

  constructor(input: CreateProviderRegistryInput) {
    this.#capabilities = new Map(input.capabilities.map((entry) => [entry.id, structuredClone(entry)]));
    this.#providers = new Map(input.providers.map((entry) => [entry.id, structuredClone(entry)]));
    const previous = new Map((input.previous_health ?? []).map((entry) => [entry.provider_id, entry]));
    this.#statuses = new Map(input.providers.map((entry) => [entry.id, statusFor(
      entry, input.discoveries ?? [], previous.get(entry.id), input.host, input.host_version,
    )]));
  }

  listCapabilities(): CapabilityDefinition[] {
    return [...this.#capabilities.values()].sort((left, right) => left.stage - right.stage || left.id.localeCompare(right.id)).map((entry) => structuredClone(entry));
  }

  listProviders(): ProviderDefinition[] {
    return [...this.#providers.values()].sort((left, right) => left.id.localeCompare(right.id)).map((entry) => structuredClone(entry));
  }

  getCapability(id: string): CapabilityDefinition | null {
    const value = this.#capabilities.get(id);
    return value ? structuredClone(value) : null;
  }

  getProvider(id: string): ProviderDefinition | null {
    const value = this.#providers.get(id);
    return value ? structuredClone(value) : null;
  }

  getStatus(id: string): ProviderRegistryStatus {
    return structuredClone(this.#statuses.get(id) ?? {
      health: "missing", reason: "NOT_INSTALLED", selected_path_alias: null, selected_digest: null, shadowed_path_aliases: [],
    });
  }

  validateRequestedCapabilities(ids: readonly string[]): RequestedCapabilityValidation {
    const requested = [...new Set(ids)].sort();
    const unknown = requested.filter((id) => !this.#capabilities.has(id));
    if (unknown.length > 0) return { ok: false, code: "UNKNOWN_CAPABILITY", capabilities: unknown };
    for (const id of requested) {
      const incompatible = this.#capabilities.get(id)?.incompatible_with ?? [];
      const conflict = requested.find((candidate) => incompatible.includes(candidate));
      if (conflict) return { ok: false, code: "INCOMPATIBLE_CAPABILITIES", capabilities: [id, conflict].sort() };
    }
    return { ok: true };
  }
}

export function createProviderRegistry(input: CreateProviderRegistryInput): ProviderRegistry {
  const issues = [
    ...input.capabilities.flatMap(validateCapability),
    ...input.providers.flatMap(validateProvider),
  ];
  if (issues.length === 0) issues.push(...validateGraph(input.capabilities, input.providers));
  if (issues.length > 0) throw new ProviderRegistryValidationError(issues);
  return new ProviderRegistry(input);
}

export async function loadProviderRegistry(input: LoadProviderRegistryInput): Promise<ProviderRegistry> {
  const capabilities: CapabilityDefinition[] = [];
  const providers: ProviderDefinition[] = [];
  const entries = (await readdir(input.directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const document = parse(await readFile(join(input.directory, entry.name), "utf8"), { merge: true }) as unknown;
    if (!plain(document) || document.schema_version !== 1) {
      throw new ProviderRegistryValidationError([issue("INVALID_DOCUMENT", entry.name, "Expected schema_version 1")]);
    }
    const allowed = entry.name === "capabilities.yaml" ? new Set(["schema_version", "capabilities"]) : new Set(["schema_version", "providers"]);
    const extra = unknownField(document, allowed);
    if (extra) throw new ProviderRegistryValidationError([issue("UNKNOWN_FIELD", `${entry.name}.${extra}`, "Unknown document field")]);
    if (entry.name === "capabilities.yaml") {
      if (!Array.isArray(document.capabilities)) throw new ProviderRegistryValidationError([issue("INVALID_DOCUMENT", entry.name, "Capabilities must be an array")]);
      capabilities.push(...document.capabilities as CapabilityDefinition[]);
    } else {
      if (!Array.isArray(document.providers)) throw new ProviderRegistryValidationError([issue("INVALID_DOCUMENT", entry.name, "Providers must be an array")]);
      providers.push(...document.providers as ProviderDefinition[]);
    }
  }
  const { directory: _directory, ...options } = input;
  return createProviderRegistry({ capabilities, providers, ...options });
}

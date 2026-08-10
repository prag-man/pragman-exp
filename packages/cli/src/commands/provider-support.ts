import { access, lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverKnownHosts, type DiscoveryRecord } from "../../../provider-registry/src/discovery.ts";
import { loadProviderRegistry, type HostId, type ProviderDefinition, type ProviderDiscovery, type ProviderRegistry, type ProviderSideEffect } from "../../../provider-registry/src/index.ts";
import { contentDigest, loadProviderOverrides, normalizeAbsolutePath, resolveContainedPath } from "../../../config/src/index.ts";
import type { Capability, Provider, ProviderHealth, ProviderTrust, Sensitivity, SideEffect } from "../../../router/src/index.ts";
import type { CliArguments } from "../args.ts";

const HOSTS = new Set<HostId>(["codex", "claude-code", "cursor"]);
const MAX_TUNE_JOURNAL_BYTES = 10 * 1024 * 1024;
const MAX_TUNE_RECORDS = 10_000;
const TRUST_SENSITIVITY: Record<ProviderTrust, Sensitivity> = {
  bundled: "restricted", curated: "confidential", "workspace-approved": "restricted", discovered: "public",
};
const SIDE_EFFECT_MAP: Partial<Record<ProviderSideEffect, SideEffect>> = {
  "project-file-write": "project-file-write",
  "external-message": "external-message",
  "issue-write": "issue-write",
  "pull-request-write": "pull-request-write",
  purchase: "purchase",
  "external-account-mutation": "external-account-mutation",
  deploy: "deployment",
  "production-data-write": "production-data-write",
  "credential-access": "credential-use",
  destructive: "destructive-action",
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function regularFile(path: string): Promise<string | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_TUNE_JOURNAL_BYTES) return null;
    return bytes.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Load only tune overlays whose current bytes still match their append-only apply/rollback journal. */
export async function loadTuneOverlayPreferences(
  personalRoot: string,
  registry: ProviderRegistry,
): Promise<{ preferences: string[]; warnings: string[] }> {
  const root = normalizeAbsolutePath(personalRoot);
  const journalPath = resolveContainedPath(root, join(root, "history", "tune-changes.jsonl"));
  const raw = await regularFile(journalPath);
  if (raw === null || !raw.trim()) return { preferences: [], warnings: [] };
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length > MAX_TUNE_RECORDS) return { preferences: [], warnings: ["TUNE_OVERLAY_JOURNAL_INVALID"] };
  let records: Record<string, unknown>[];
  try {
    records = lines.map((line) => {
      const value = JSON.parse(line) as unknown;
      if (!object(value)) throw new TypeError("invalid-record");
      return value;
    });
  } catch {
    return { preferences: [], warnings: ["TUNE_OVERLAY_JOURNAL_INVALID"] };
  }
  const rolledBack = new Set(records.flatMap((record) =>
    record.record_type === "tune-rollback" && typeof record.rolled_back_change_id === "string"
      ? [record.rolled_back_change_id]
      : []));
  const active = records.filter((record) =>
    record.record_type === "tune-apply"
    && typeof record.change_id === "string" && record.change_id.startsWith("tune-")
    && !rolledBack.has(record.change_id)
    && typeof record.target_alias === "string" && record.target_alias.startsWith("private-overlay:")
    && typeof record.candidate_id === "string" && typeof record.candidate_digest === "string"
    && typeof record.preview_digest === "string" && typeof record.comparison_skill_digest === "string");
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const record of active) {
    const targetAlias = String(record.target_alias);
    const group = groups.get(targetAlias) ?? [];
    group.push(record);
    groups.set(targetAlias, group);
  }
  const preferences: string[] = [];
  const warnings: string[] = [];
  for (const [targetAlias, changes] of groups) {
    const skillAlias = targetAlias.slice("private-overlay:".length);
    if (!/^[a-z0-9-]+$/.test(skillAlias)) {
      warnings.push("TUNE_OVERLAY_JOURNAL_INVALID");
      continue;
    }
    const target = resolveContainedPath(root, join(root, "overlays", skillAlias, "eval-candidates.jsonl"));
    const overlay = await regularFile(target);
    const head = changes.at(-1)!;
    if (overlay === null || contentDigest(overlay) !== head.preview_digest) {
      warnings.push("TUNE_OVERLAY_STALE");
      continue;
    }
    let entries: Record<string, unknown>[];
    try {
      const entryLines = overlay.split("\n").filter(Boolean);
      if (entryLines.length > MAX_TUNE_RECORDS) throw new TypeError("too-many-records");
      entries = entryLines.map((line) => {
        const value = JSON.parse(line) as unknown;
        if (!object(value)) throw new TypeError("invalid-entry");
        return value;
      });
    } catch {
      warnings.push("TUNE_OVERLAY_INVALID");
      continue;
    }
    for (const change of changes) {
      const entry = entries.find((value) => value.candidate_id === change.candidate_id
        && value.candidate_digest === change.candidate_digest
        && value.approval_status === "approved");
      if (!entry || typeof entry.skill_id !== "string" || entry.skill_digest !== change.comparison_skill_digest
        || entry.evaluation_artifact_digest !== change.evidence_digest
        || skillAlias !== entry.skill_id.replaceAll(":", "--")) {
        warnings.push("TUNE_OVERLAY_INVALID");
        continue;
      }
      const provider = registry.getProvider(entry.skill_id);
      const status = provider ? registry.getStatus(entry.skill_id) : null;
      if (!provider || !status || status.health !== "healthy" || status.selected_digest !== entry.skill_digest) {
        warnings.push("TUNE_OVERLAY_SKILL_DRIFT");
        continue;
      }
      if (!preferences.includes(entry.skill_id)) preferences.push(entry.skill_id);
    }
  }
  return { preferences, warnings: [...new Set(warnings)] };
}

export function activeHost(arguments_: CliArguments): HostId {
  const selected = arguments_.host ?? "codex";
  if (!HOSTS.has(selected as HostId)) throw Object.assign(new Error("--host must be codex, claude-code, or cursor"), { code: "INVALID_INPUT" });
  return selected as HostId;
}

export async function bundledProvidersDirectory(explicit?: string): Promise<string> {
  if (explicit) {
    if (!process.env.NODE_TEST_CONTEXT) {
      throw Object.assign(new Error("Provider registry overrides are unavailable outside the test harness"), { code: "INVALID_INPUT" });
    }
    await access(join(explicit, "capabilities.yaml"));
    return explicit;
  }
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(current, "providers");
    try {
      await access(join(candidate, "capabilities.yaml"));
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw Object.assign(new Error("Bundled provider registry is unavailable"), { code: "UNAVAILABLE" });
}

function skillId(provider: ProviderDefinition): string | null {
  return provider.invoke.kind === "native-skill" || provider.invoke.kind === "prompt-handoff" ? provider.invoke.skill_id : null;
}

const CURATED_SOURCE_NAMESPACES = new Map([
  ["everyinc/compound-engineering-plugin", "compound-engineering"],
  ["garrytan/gstack", "gstack"],
  ["obra/superpowers", "superpowers"],
  ["prag-man/pragman-exp", "pragman"],
]);

function providerAliases(provider: ProviderDefinition): { exact: string[]; bare: string[] } | null {
  const id = skillId(provider);
  const namespace = CURATED_SOURCE_NAMESPACES.get(provider.source);
  if (!id || !namespace || !id.startsWith(`${namespace}:`)) return null;
  const name = id.slice(namespace.length + 1);
  return {
    exact: [id, ...(namespace === "pragman" ? [`pragman-${name}`] : [])],
    bare: namespace === "pragman" ? [] : [name],
  };
}

function addAlias(index: Map<string, ProviderDefinition[]>, alias: string, provider: ProviderDefinition): void {
  const values = index.get(alias) ?? [];
  values.push(provider);
  index.set(alias, values);
}

/** Host discovery identifies installations; explicit curated aliases supply repository source identity. */
export function mapDiscoveries(records: readonly DiscoveryRecord[], definitions: readonly ProviderDefinition[]): ProviderDiscovery[] {
  const exact = new Map<string, ProviderDefinition[]>();
  const bare = new Map<string, ProviderDefinition[]>();
  for (const provider of definitions) {
    const aliases = providerAliases(provider);
    if (!aliases) continue;
    for (const alias of aliases.exact) addAlias(exact, alias, provider);
    for (const alias of aliases.bare) addAlias(bare, alias, provider);
  }
  const exactProviderIds = new Set(records.flatMap((record) => {
    const matches = exact.get(record.skill_id) ?? [];
    return matches.length === 1 ? [skillId(matches[0]!)!] : [];
  }));
  return records.flatMap((record) => {
    const exactMatches = exact.get(record.skill_id) ?? [];
    const matches = exactMatches.length > 0 ? exactMatches : bare.get(record.skill_id) ?? [];
    if (matches.length !== 1) return [];
    const provider = matches[0]!;
    if (exactMatches.length === 0 && exactProviderIds.has(skillId(provider)!)) return [];
    return [{
      source: provider.source,
      skill_id: skillId(provider)!,
      version: provider.source_version,
      install_scope: record.install_scope,
      path_alias: record.path_alias,
      digest: record.digest,
      trust: provider.trust,
    }];
  });
}

export async function loadRuntimeProviderRegistry(arguments_: CliArguments): Promise<{ registry: ProviderRegistry; host: HostId; warnings: string[]; personalPreferences: string[] }> {
  const directory = await bundledProvidersDirectory(process.env.NODE_TEST_CONTEXT ? process.env.PRAGMAN_TEST_PROVIDERS_DIR : undefined);
  const host = activeHost(arguments_);
  const base = await loadProviderRegistry({ directory });
  const personalRoot = normalizeAbsolutePath(arguments_.config ?? join(homedir(), ".pragman"));
  const overrides = await loadProviderOverrides(personalRoot);
  const scan = await discoverKnownHosts({ homeRoot: homedir(), ...(arguments_.projectRoot ? { projectRoot: arguments_.projectRoot } : {}) });
  const discoveries = mapDiscoveries(scan.installations.filter((record) =>
    record.source === host && record.health === "healthy" && record.shadowed_by === null), base.listProviders());
  const definitions = new Map(base.listProviders().map((provider) => [provider.id, provider]));
  const previousHealth = overrides.trust.flatMap((record) => {
    const definition = definitions.get(record.provider_id);
    return definition && definition.source === record.source && definition.source_version === record.source_version
      ? [{ provider_id: record.provider_id, version: record.source_version, digest: record.digest, health: "healthy" as const }]
      : [];
  });
  const registry = await loadProviderRegistry({
    directory,
    discoveries,
    previous_health: previousHealth,
    ...(arguments_.hostVersion ? { host, host_version: arguments_.hostVersion } : {}),
  });
  const tune = await loadTuneOverlayPreferences(personalRoot, registry);
  const personalPreferences = [...new Set([
    ...overrides.prefer.filter((providerId) => registry.getProvider(providerId) !== null),
    ...tune.preferences,
  ])];
  return { registry, host, warnings: [...new Set([...scan.warnings.map((warning) => warning.code), ...tune.warnings])], personalPreferences };
}

export function projectProviderRegistry(registry: ProviderRegistry): { providers: Provider[]; capabilities: Capability[] } {
  const providers = registry.listProviders().map((definition): Provider => {
    const status = registry.getStatus(definition.id);
    return {
      id: definition.id,
      installed: status.selected_path_alias !== null || definition.invoke.kind === "cli",
      handoffCapable: definition.invoke.kind === "prompt-handoff" || definition.invoke.kind === "manual" || definition.invoke.kind === "cli",
      health: status.health as ProviderHealth,
      compatible: status.health !== "incompatible" && status.health !== "conflict" && status.health !== "quarantined",
      capabilities: [...definition.capabilities],
      hostSupport: [...definition.host_support],
      trust: definition.trust,
      contextMaximumSensitivity: definition.context_policy.maximum_sensitivity,
      trustMaximumSensitivity: TRUST_SENSITIVITY[definition.trust],
      sideEffects: definition.side_effects.flatMap((effect) => SIDE_EFFECT_MAP[effect] ? [SIDE_EFFECT_MAP[effect]!] : []),
      workflowWeight: definition.workflow_weight,
      ...(definition.evaluation_confidence === undefined ? {} : { evaluationConfidence: definition.evaluation_confidence }),
    };
  });
  const capabilities = registry.listCapabilities().map((definition): Capability => ({
    id: definition.id,
    stage: definition.stage,
    dependsOn: [...definition.depends_on],
    incompatibleWith: [...(definition.incompatible_with ?? [])],
  }));
  return { providers, capabilities };
}

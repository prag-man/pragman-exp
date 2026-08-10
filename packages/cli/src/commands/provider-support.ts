import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverKnownHosts, type DiscoveryRecord } from "../../../provider-registry/src/discovery.ts";
import { loadProviderRegistry, type HostId, type ProviderDefinition, type ProviderDiscovery, type ProviderRegistry, type ProviderSideEffect } from "../../../provider-registry/src/index.ts";
import { loadProviderOverrides, normalizeAbsolutePath } from "../../../config/src/index.ts";
import type { Capability, Provider, ProviderHealth, ProviderTrust, Sensitivity, SideEffect } from "../../../router/src/index.ts";
import type { CliArguments } from "../args.ts";

const HOSTS = new Set<HostId>(["codex", "claude-code", "cursor"]);
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
  const personalPreferences = overrides.prefer.filter((providerId) => registry.getProvider(providerId) !== null);
  return { registry, host, warnings: [...new Set(scan.warnings.map((warning) => warning.code))], personalPreferences };
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

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverKnownHosts, type DiscoveryRecord } from "../../../provider-registry/src/discovery.ts";
import { loadProviderRegistry, type HostId, type ProviderDefinition, type ProviderDiscovery, type ProviderRegistry, type ProviderSideEffect } from "../../../provider-registry/src/index.ts";
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

/** Host discovery identifies installations; curated definitions supply their source identity and supported version. */
export function mapDiscoveries(records: readonly DiscoveryRecord[], definitions: readonly ProviderDefinition[]): ProviderDiscovery[] {
  const bySkill = new Map<string, ProviderDefinition[]>();
  for (const provider of definitions) {
    const id = skillId(provider);
    if (!id) continue;
    const values = bySkill.get(id) ?? [];
    values.push(provider);
    bySkill.set(id, values);
  }
  return records.flatMap((record) => (bySkill.get(record.skill_id) ?? []).map((provider) => ({
    source: provider.source,
    skill_id: record.skill_id,
    version: provider.source_version,
    install_scope: record.install_scope,
    path_alias: record.path_alias,
    digest: record.digest,
    trust: provider.trust,
  })));
}

export async function loadRuntimeProviderRegistry(arguments_: CliArguments): Promise<{ registry: ProviderRegistry; host: HostId; warnings: string[] }> {
  const directory = await bundledProvidersDirectory(arguments_.providersDir);
  const host = activeHost(arguments_);
  const base = await loadProviderRegistry({ directory });
  const scan = await discoverKnownHosts({ homeRoot: homedir(), ...(arguments_.projectRoot ? { projectRoot: arguments_.projectRoot } : {}) });
  const discoveries = mapDiscoveries(scan.installations.filter((record) => record.health === "healthy" && record.shadowed_by === null), base.listProviders());
  const registry = await loadProviderRegistry({
    directory,
    discoveries,
    ...(arguments_.hostVersion ? { host, host_version: arguments_.hostVersion } : {}),
  });
  return { registry, host, warnings: scan.warnings.map((warning) => warning.code) };
}

function routerHealth(provider: ProviderDefinition, registry: ProviderRegistry): ProviderHealth {
  if (provider.trust === "bundled" && provider.source === "prag-man/pragman-exp") return "healthy";
  return registry.getStatus(provider.id).health;
}

export function projectProviderRegistry(registry: ProviderRegistry): { providers: Provider[]; capabilities: Capability[] } {
  const providers = registry.listProviders().map((definition): Provider => {
    const status = registry.getStatus(definition.id);
    const bundled = definition.trust === "bundled" && definition.source === "prag-man/pragman-exp";
    return {
      id: definition.id,
      installed: bundled || status.selected_path_alias !== null || definition.invoke.kind === "cli",
      handoffCapable: definition.invoke.kind === "prompt-handoff" || definition.invoke.kind === "manual" || definition.invoke.kind === "cli",
      health: routerHealth(definition, registry),
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

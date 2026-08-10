import { homedir } from "node:os";
import { join } from "node:path";

import personalSchema from "../../../config/schemas/personal-config.schema.json" with { type: "json" };
import providerSchema from "../../../config/schemas/provider.schema.json" with { type: "json" };
import { ConfigError, loadPersonalConfig, normalizeAbsolutePath } from "../../../config/src/index.ts";
import { discoverKnownHosts } from "../../../provider-registry/src/discovery.ts";
import type { CliArguments } from "../args.ts";
import { EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution } from "./events.ts";

type ComponentHealth = "healthy" | "degraded" | "broken";

interface ComponentStatus {
  component: "core" | "cli" | "schemas" | "configuration" | "providers" | "host-adapters";
  health: ComponentHealth;
  summary: string;
}

function root(arguments_: CliArguments): string {
  return normalizeAbsolutePath(arguments_.config ?? join(homedir(), ".pragman"));
}

async function configurationHealth(arguments_: CliArguments): Promise<ComponentStatus> {
  try {
    await loadPersonalConfig(root(arguments_));
    return { component: "configuration", health: "healthy", summary: "Personal configuration schema is supported." };
  } catch (error) {
    if (error instanceof ConfigError && error.code === "NOT_FOUND") {
      return { component: "configuration", health: "degraded", summary: "Personal configuration is not initialized." };
    }
    return { component: "configuration", health: "broken", summary: "Personal configuration is invalid or incompatible." };
  }
}

function overall(components: readonly ComponentStatus[]): ComponentHealth {
  if (components.some((component) => component.health === "broken")) return "broken";
  if (components.some((component) => component.health === "degraded")) return "degraded";
  return "healthy";
}

export async function executeDoctorCommand(arguments_: CliArguments): Promise<CommandExecution> {
  const command = "doctor";
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  let scan;
  try {
    scan = await discoverKnownHosts({
      homeRoot: homedir(),
      ...(arguments_.projectRoot ? { projectRoot: arguments_.projectRoot } : {}),
    });
  } catch {
    scan = {
      schema_version: 1 as const,
      installations: [],
      warnings: [{ code: "INVALID_METADATA" as const, path_alias: "known-host-roots" }],
      truncated: true,
      bounds: { maximum_hosts: 8, maximum_skills_per_root: 256, maximum_metadata_bytes: 32_768 },
    };
  }
  const providerHealth: ComponentHealth = scan.installations.some((record) => record.health === "conflict" || record.health === "degraded")
    ? "broken"
    : scan.truncated ? "degraded" : "healthy";
  const components: ComponentStatus[] = [
    {
      component: "core",
      health: nodeMajor >= 22 && nodeMajor < 25 ? "healthy" : "broken",
      summary: nodeMajor >= 22 && nodeMajor < 25 ? "Node runtime is supported." : "Node runtime is outside >=22 <25.",
    },
    { component: "cli", health: "healthy", summary: "CLI command dispatcher is available." },
    {
      component: "schemas",
      health: personalSchema.$schema && providerSchema.$schema ? "healthy" : "broken",
      summary: "Core and provider schemas are bundled.",
    },
    await configurationHealth(arguments_),
    {
      component: "providers",
      health: providerHealth,
      summary: providerHealth === "healthy" ? `${scan.installations.length} installation metadata records are usable.` : "Installation metadata needs attention.",
    },
    {
      component: "host-adapters",
      health: "healthy",
      summary: "Known-host metadata discovery is available for Codex, Claude Code, and Cursor.",
    },
  ];
  const status = overall(components);
  return {
    exitCode: status === "healthy" ? EXIT_CODES.success : EXIT_CODES.unavailable,
    envelope: successEnvelope(command, { overall: status, components }, scan.warnings.map((warning) => warning.code)),
    human: `Pragman health: ${status}.`,
    stderr: status !== "healthy",
  };
}

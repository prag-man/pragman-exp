import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import {
  atomicWrite,
  ConfigError,
  contentDigest,
  loadPersonalConfig,
  normalizeAbsolutePath,
  personalConfigPath,
  type PersonalConfig,
} from "../../../config/src/index.ts";
import { discoverKnownHosts, type DiscoveryReport } from "../../../provider-registry/src/discovery.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution, CommandIo } from "./events.ts";

const SAMPLE_ROUTE = Object.freeze({
  status: "handoff-required",
  lane: "fast",
  capability: "pragman.route",
  instructions: "Use the active host to route a read-only sample task; do not claim provider execution.",
});

const DEFAULT_PERSONAL_CONFIG: PersonalConfig = {
  schema_version: 1,
  privacy: { default_sensitivity: "internal", restricted_egress: false },
  updates: { channel: "stable" },
  output: { format: "human", color: "auto" },
  telemetry: { enabled: false },
  measurement: { local_events: true },
  routing: { default_lane: "adaptive" },
};

function execution(exitCode: number, envelope: ReturnType<typeof successEnvelope> | ReturnType<typeof errorEnvelope>, human: string, stderr = false): CommandExecution {
  return { exitCode, envelope, human, stderr };
}

function personalRoot(arguments_: CliArguments): string {
  return normalizeAbsolutePath(arguments_.config ?? join(homedir(), ".pragman"));
}

function configBytes(): Uint8Array {
  return Buffer.from(stringify(DEFAULT_PERSONAL_CONFIG, { lineWidth: 0 }));
}

async function configState(root: string): Promise<{ state: "missing" | "healthy" | "broken"; config: PersonalConfig | null }> {
  try {
    return { state: "healthy", config: await loadPersonalConfig(root) };
  } catch (error) {
    if (error instanceof ConfigError && error.code === "NOT_FOUND") return { state: "missing", config: null };
    if (error instanceof ConfigError) return { state: "broken", config: null };
    throw error;
  }
}

async function workspaceAliases(root: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, "workspaces"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function selectedString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function interview(config: PersonalConfig | null, scan: DiscoveryReport, workspaces: readonly string[]) {
  const privacy = config?.privacy as Record<string, unknown> | undefined;
  const routing = config?.routing as Record<string, unknown> | undefined;
  const questions = [
    { id: "role", prompt: "Which role should shape Pragman's defaults?" },
    { id: "recurring-work", prompt: "Which recurring work should Pragman optimize first?" },
    { id: "approval-boundaries", prompt: "Which actions must always require explicit approval?" },
  ];
  return {
    defaults: {
      telemetry_enabled: false,
      default_sensitivity: selectedString(privacy?.default_sensitivity, "internal"),
      routing_lane: selectedString(routing?.default_lane, "adaptive"),
      discovered_skill_count: scan.installations.length,
      workspace_count: workspaces.length,
    },
    questions,
  };
}

export async function executeInitCommand(arguments_: CliArguments, _io: CommandIo): Promise<CommandExecution> {
  const command = "init";
  try {
    const root = personalRoot(arguments_);
    const [scan, current, workspaces] = await Promise.all([
      discoverKnownHosts({ homeRoot: homedir(), ...(arguments_.projectRoot ? { projectRoot: arguments_.projectRoot } : {}) }),
      configState(root),
      workspaceAliases(root),
    ]);
    const conflicts = scan.installations.filter((record) => record.health === "conflict");
    const broken = scan.installations.filter((record) => record.health === "degraded");
    if (conflicts.length > 0 || current.state === "broken" || broken.length > 0) {
      const questionIds = conflicts.length > 0 ? ["installation-conflicts"] : ["repair-broken-metadata"];
      const message = "Resolve discovered installation health issues before applying initialization changes";
      return execution(EXIT_CODES.needsInput, errorEnvelope(command, "NEEDS_INPUT", message, {
        question_ids: questionIds,
        conflict_count: conflicts.length,
        degraded_count: broken.length + (current.state === "broken" ? 1 : 0),
        installations: scan.installations,
        proposed_changes: [],
      }), message, true);
    }

    const environment = current.state === "missing" && scan.installations.length === 0 && workspaces.length === 0 ? "clean" : "populated";
    const bytes = configBytes();
    const previewDigest = current.state === "missing" ? contentDigest(bytes) : null;
    const proposedChanges = previewDigest === null ? [] : [{
      target_alias: "personal-config",
      action: "create",
      preview_digest: previewDigest,
      approval_classes: ["local-config-write"],
    }];
    const data = {
      environment,
      mutated: false,
      preview_digest: previewDigest,
      proposed_changes: proposedChanges,
      operating_map: {
        installed_skills: scan.installations.map((record) => record.path_alias),
        workspaces,
        host_sources: [...new Set(scan.installations.map((record) => record.source))].sort(),
      },
      interview: interview(current.config, scan, workspaces),
      sample_route: null as typeof SAMPLE_ROUTE | null,
    };
    if (!arguments_.applyDigest) {
      return execution(EXIT_CODES.success, successEnvelope(command, data), previewDigest
        ? `Initialization preview ${previewDigest}; no files were written.`
        : "Existing initialization is healthy; no changes proposed.");
    }
    if (previewDigest === null || arguments_.applyDigest !== previewDigest) {
      const message = "Apply digest does not match the current initialization preview";
      return execution(EXIT_CODES.denied, errorEnvelope(command, "STALE_PREVIEW", message), message, true);
    }
    await mkdir(root, { recursive: true });
    const target = personalConfigPath(root);
    const lock = join(root, ".change-lock");
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const message = "Another configuration writer is active";
        return execution(EXIT_CODES.temporary, errorEnvelope(command, "TEMPORARY_FAILURE", message, null, true), message, true);
      }
      throw error;
    }
    try {
      try {
        const metadata = await lstat(target);
        if (metadata.isSymbolicLink()) throw Object.assign(new Error("Personal configuration target is a symbolic link"), { code: "PRIVACY_DENIED" });
        const message = "Personal configuration appeared after preview";
        return execution(EXIT_CODES.denied, errorEnvelope(command, "STALE_PREVIEW", message), message, true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await atomicWrite(target, bytes);
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
    return execution(EXIT_CODES.success, successEnvelope(command, { ...data, mutated: true, sample_route: SAMPLE_ROUTE }), "Initialization applied and the manual sample route is ready.");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "PRIVACY_DENIED") {
      const message = error instanceof Error ? error.message : "Unsafe initialization path";
      return execution(EXIT_CODES.denied, errorEnvelope(command, code, message), message, true);
    }
    const message = "Initialization could not complete";
    return execution(EXIT_CODES.temporary, errorEnvelope(command, "TEMPORARY_FAILURE", message, null, true), message, true);
  }
}

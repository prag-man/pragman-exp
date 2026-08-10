import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import {
  atomicWrite,
  ConfigError,
  contentDigest,
  loadPersonalConfig,
  loadPersonalProfile,
  normalizeAbsolutePath,
  personalConfigPath,
  personalProfilePath,
  validatePersonalProfile,
  type PersonalConfig,
  type PersonalProfile,
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
const MAX_PROFILE_INPUT_BYTES = 1024 * 1024;
const SECRET = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S{8,})/i;
const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|password|secret|private[_-]?key)$/i;

interface FileState<T> {
  state: "missing" | "healthy" | "broken";
  value: T | null;
  bytes: Uint8Array | null;
}

interface PlannedWrite {
  targetAlias: "personal-config" | "personal-profile";
  target: string;
  action: "create" | "update";
  bytes: Uint8Array;
  baseDigest: string | null;
  contentDigest: string;
}

function execution(exitCode: number, envelope: ReturnType<typeof successEnvelope> | ReturnType<typeof errorEnvelope>, human: string, stderr = false): CommandExecution {
  return { exitCode, envelope, human, stderr };
}

function personalRoot(arguments_: CliArguments): string {
  return normalizeAbsolutePath(arguments_.config ?? join(homedir(), ".pragman"));
}

function configBytes(): Uint8Array {
  return Buffer.from(stringify(DEFAULT_PERSONAL_CONFIG, { lineWidth: 0 }));
}

function profileDocument(value: PersonalProfile): PersonalProfile {
  const result: PersonalProfile = {
    schema_version: 1,
    profile_id: value.profile_id,
    roles: [...value.roles],
    responsibilities: [...value.responsibilities],
  };
  if (value.preferences !== undefined) result.preferences = structuredClone(value.preferences);
  if (value.prohibitions !== undefined) result.prohibitions = [...value.prohibitions];
  if (value.authority !== undefined) result.authority = [...value.authority];
  return result;
}

function profileBytes(value: PersonalProfile): Uint8Array {
  return Buffer.from(stringify(profileDocument(value), { lineWidth: 0 }));
}

function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return SECRET.test(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  return value !== null && typeof value === "object" && Object.entries(value).some(([key, nested]) => (
    (SECRET_KEY.test(key) && nested !== null && nested !== "") || containsSecret(nested)
  ));
}

async function readProfileInput(path: string | undefined): Promise<PersonalProfile | null> {
  if (!path) return null;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_PROFILE_INPUT_BYTES) {
      throw new ConfigError("INVALID_CONFIGURATION", "Profile input must be a regular JSON file no larger than 1 MiB");
    }
    const raw = await handle.readFile("utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new ConfigError("INVALID_CONFIGURATION", "Profile input must be valid JSON");
    }
    const profile = profileDocument(validatePersonalProfile(value));
    if (containsSecret(profile)) throw Object.assign(new Error("Profile input appears to contain a secret value"), { code: "PRIVACY_DENIED" });
    return profile;
  } catch (error) {
    if (error instanceof ConfigError || (error as { code?: string }).code === "PRIVACY_DENIED") throw error;
    throw new ConfigError("INVALID_CONFIGURATION", "Unable to read selected profile input");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function configState(root: string): Promise<FileState<PersonalConfig>> {
  try {
    const value = await loadPersonalConfig(root);
    const bytes = await readFile(personalConfigPath(root));
    return { state: "healthy", value, bytes };
  } catch (error) {
    if (error instanceof ConfigError && error.code === "NOT_FOUND") return { state: "missing", value: null, bytes: null };
    if (error instanceof ConfigError) return { state: "broken", value: null, bytes: null };
    throw error;
  }
}

async function profileState(root: string): Promise<FileState<PersonalProfile>> {
  try {
    const value = await loadPersonalProfile(root);
    const bytes = await readFile(personalProfilePath(root));
    return { state: "healthy", value, bytes };
  } catch (error) {
    if (error instanceof ConfigError && error.code === "NOT_FOUND") return { state: "missing", value: null, bytes: null };
    if (error instanceof ConfigError) return { state: "broken", value: null, bytes: null };
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

function interview(config: PersonalConfig | null, profile: PersonalProfile | null, scan: DiscoveryReport, workspaces: readonly string[]) {
  const privacy = config?.privacy as Record<string, unknown> | undefined;
  const routing = config?.routing as Record<string, unknown> | undefined;
  const questions = [];
  if (!profile) questions.push({ id: "role", prompt: "Which role should shape Pragman's defaults?" });
  if (!profile) questions.push({ id: "recurring-work", prompt: "Which recurring work should Pragman optimize first?" });
  if (!profile || (!("authority" in profile) && !("prohibitions" in profile))) {
    questions.push({ id: "approval-boundaries", prompt: "Which actions must always require explicit approval?" });
  }
  return {
    defaults: {
      telemetry_enabled: false,
      default_sensitivity: selectedString(privacy?.default_sensitivity, "internal"),
      routing_lane: selectedString(routing?.default_lane, "adaptive"),
      discovered_skill_count: scan.installations.length,
      workspace_count: workspaces.length,
      profile_configured: profile !== null,
    },
    questions,
  };
}

function proposedWrites(root: string, currentConfig: FileState<PersonalConfig>, currentProfile: FileState<PersonalProfile>, selectedProfile: PersonalProfile | null): PlannedWrite[] {
  const operations: PlannedWrite[] = [];
  if (currentConfig.state === "missing") {
    const bytes = configBytes();
    operations.push({
      targetAlias: "personal-config",
      target: personalConfigPath(root),
      action: "create",
      bytes,
      baseDigest: null,
      contentDigest: contentDigest(bytes),
    });
  }
  if (selectedProfile) {
    const bytes = profileBytes(selectedProfile);
    const unchanged = currentProfile.value !== null && contentDigest(profileBytes(currentProfile.value)) === contentDigest(bytes);
    if (!unchanged) {
      operations.push({
        targetAlias: "personal-profile",
        target: personalProfilePath(root),
        action: currentProfile.state === "missing" ? "create" : "update",
        bytes,
        baseDigest: currentProfile.bytes === null ? null : contentDigest(currentProfile.bytes),
        contentDigest: contentDigest(bytes),
      });
    }
  }
  return operations;
}

function transactionDigest(operations: readonly PlannedWrite[]): string | null {
  if (operations.length === 0) return null;
  return contentDigest(JSON.stringify({
    schema_version: 1,
    operations: operations.map((operation) => ({
      target_alias: operation.targetAlias,
      action: operation.action,
      base_digest: operation.baseDigest,
      content_digest: operation.contentDigest,
    })),
  }));
}

async function assertExpectedTarget(operation: PlannedWrite): Promise<Uint8Array | null> {
  let handle;
  try {
    const metadata = await lstat(operation.target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw Object.assign(new Error("Personal configuration target is not a regular local file"), { code: "PRIVACY_DENIED" });
    }
    if (operation.baseDigest === null) throw new ConfigError("STALE_PREVIEW", "A configuration target appeared after preview");
    handle = await open(operation.target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) throw Object.assign(new Error("Personal configuration target is not a regular local file"), { code: "PRIVACY_DENIED" });
    const bytes = await handle.readFile();
    if (contentDigest(bytes) !== operation.baseDigest) throw new ConfigError("STALE_PREVIEW", "A configuration target changed after preview");
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw Object.assign(new Error("Personal configuration target became a symbolic link"), { code: "PRIVACY_DENIED" });
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (operation.baseDigest !== null) throw new ConfigError("STALE_PREVIEW", "A configuration target disappeared after preview");
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function applyTransaction(root: string, operations: readonly PlannedWrite[]): Promise<void> {
  await mkdir(root, { recursive: true });
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw Object.assign(new Error("Personal configuration root is not a regular local directory"), { code: "PRIVACY_DENIED" });
  }
  const lock = join(root, ".change-lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ConfigError("TEMPORARY_FAILURE", "Another configuration writer is active");
    throw error;
  }
  try {
    const snapshots = await Promise.all(operations.map(assertExpectedTarget));
    let written = 0;
    try {
      for (const operation of operations) {
        await atomicWrite(operation.target, operation.bytes);
        written += 1;
      }
    } catch (error) {
      let rollbackError: unknown = null;
      for (let index = written - 1; index >= 0; index -= 1) {
        try {
          const snapshot = snapshots[index]!;
          if (snapshot === null) await rm(operations[index]!.target, { force: true });
          else await atomicWrite(operations[index]!.target, snapshot);
        } catch (caught) {
          rollbackError ??= caught;
        }
      }
      if (rollbackError) throw new ConfigError("TEMPORARY_FAILURE", "Initialization failed and its rollback could not complete");
      throw error;
    }
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function executeInitCommand(arguments_: CliArguments, _io: CommandIo): Promise<CommandExecution> {
  const command = "init";
  try {
    const root = personalRoot(arguments_);
    const selectedProfile = await readProfileInput(arguments_.file);
    const [scan, currentConfig, currentProfile, workspaces] = await Promise.all([
      discoverKnownHosts({ homeRoot: homedir(), ...(arguments_.projectRoot ? { projectRoot: arguments_.projectRoot } : {}) }),
      configState(root),
      profileState(root),
      workspaceAliases(root),
    ]);
    const conflicts = scan.installations.filter((record) => record.health === "conflict");
    const broken = scan.installations.filter((record) => record.health === "degraded");
    if (conflicts.length > 0 || currentConfig.state === "broken" || currentProfile.state === "broken" || broken.length > 0) {
      const questionIds = conflicts.length > 0 ? ["installation-conflicts"] : ["repair-broken-metadata"];
      const message = "Resolve discovered installation health issues before applying initialization changes";
      return execution(EXIT_CODES.needsInput, errorEnvelope(command, "NEEDS_INPUT", message, {
        question_ids: questionIds,
        conflict_count: conflicts.length,
        degraded_count: broken.length + (currentConfig.state === "broken" ? 1 : 0) + (currentProfile.state === "broken" ? 1 : 0),
        installations: scan.installations,
        proposed_changes: [],
      }), message, true);
    }

    const environment = currentConfig.state === "missing" && currentProfile.state === "missing" && scan.installations.length === 0 && workspaces.length === 0 ? "clean" : "populated";
    const operations = proposedWrites(root, currentConfig, currentProfile, selectedProfile);
    const previewDigest = transactionDigest(operations);
    const proposedChanges = operations.map((operation) => ({
      target_alias: operation.targetAlias,
      action: operation.action,
      content_digest: operation.contentDigest,
      preview_digest: previewDigest,
      approval_classes: ["local-config-write"],
    }));
    const effectiveProfile = selectedProfile ?? currentProfile.value;
    const data = {
      environment,
      mutated: false,
      preview_digest: previewDigest,
      proposed_changes: proposedChanges,
      operating_map: {
        installed_skills: scan.installations.map((record) => record.path_alias),
        workspaces,
        hosts: scan.environment.hosts,
        installed_plugins: scan.environment.plugins.map((record) => record.path_alias),
        declared_mcp_servers: scan.environment.mcp_servers.map((record) => record.path_alias),
        instruction_files: scan.environment.instruction_files.map((record) => record.path_alias),
        repositories: scan.environment.repositories,
        profile_configured: effectiveProfile !== null,
      },
      interview: interview(currentConfig.value, effectiveProfile, scan, workspaces),
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
    await applyTransaction(root, operations);
    return execution(EXIT_CODES.success, successEnvelope(command, { ...data, mutated: true, sample_route: SAMPLE_ROUTE }), "Initialization applied and the manual sample route is ready.");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "PRIVACY_DENIED") {
      const message = error instanceof Error ? error.message : "Unsafe initialization path";
      return execution(EXIT_CODES.denied, errorEnvelope(command, code, message), message, true);
    }
    if (error instanceof ConfigError && (error.code === "INVALID_CONFIGURATION" || error.code === "INCOMPATIBLE_VERSION" || error.code === "INVALID_PATH")) {
      const message = error.message;
      return execution(EXIT_CODES.invalid, errorEnvelope(command, error.code, message, error.details), message, true);
    }
    if (error instanceof ConfigError && error.code === "STALE_PREVIEW") {
      return execution(EXIT_CODES.denied, errorEnvelope(command, error.code, error.message), error.message, true);
    }
    if (error instanceof ConfigError && error.code === "TEMPORARY_FAILURE") {
      return execution(EXIT_CODES.temporary, errorEnvelope(command, error.code, error.message, null, true), error.message, true);
    }
    const message = "Initialization could not complete";
    return execution(EXIT_CODES.temporary, errorEnvelope(command, "TEMPORARY_FAILURE", message, null, true), message, true);
  }
}

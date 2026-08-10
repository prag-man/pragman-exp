import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { stringify } from "yaml";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import workspaceSchema from "../../../config/schemas/workspace.schema.json" with { type: "json" };
import projectSchema from "../../../config/schemas/project.schema.json" with { type: "json" };
import {
  ConfigError,
  applyChange,
  atomicWrite,
  contentDigest,
  loadConfigurationContext,
  loadPersonalConfig,
  loadProjectManifest,
  loadWorkspaceConfig,
  mergeConfiguration,
  normalizeAbsolutePath,
  previewChange,
  projectManifestPath,
  resolveContainedPath,
  workspaceConfigPath,
  type JsonObject,
  type JsonValue,
  type PatchOperation,
  type ProjectManifest,
  type WorkspaceConfig,
} from "../../../config/src/index.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution, CommandIo } from "./events.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true, removeAdditional: false, coerceTypes: false });
const validateWorkspace = ajv.compile(workspaceSchema) as ValidateFunction<WorkspaceConfig>;
const validateProject = ajv.compile(projectSchema) as ValidateFunction<ProjectManifest>;
const SECRET = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S{8,})/i;

function execution(exitCode: number, envelope: ReturnType<typeof successEnvelope> | ReturnType<typeof errorEnvelope>, human: string, stderr = false): CommandExecution {
  return { exitCode, envelope, human, stderr };
}

function fail(command: string, exitCode: number, code: string, message: string, details: unknown = null, retryable = false): CommandExecution {
  return execution(exitCode, errorEnvelope(command, code, message, details, retryable), message, true);
}

function personalRoot(arguments_: CliArguments): string {
  return normalizeAbsolutePath(arguments_.config ?? join(homedir(), ".pragman"));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return SECRET.test(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  return isObject(value) && Object.values(value).some(containsSecret);
}

async function readJson(arguments_: CliArguments, io: CommandIo): Promise<unknown> {
  let text: string;
  try {
    text = arguments_.file ? await readFile(arguments_.file, "utf8") : await io.readStdin();
  } catch {
    throw new ConfigError("INVALID_CONFIGURATION", "Unable to read selected JSON input");
  }
  if (!text.trim()) throw Object.assign(new Error("JSON input is required"), { code: "NEEDS_INPUT" });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConfigError("INVALID_CONFIGURATION", "Input must be valid JSON");
  }
}

function schemaIssues(validator: ValidateFunction): string[] {
  return (validator.errors ?? []).map((issue) => `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}`);
}

function assertWorkspace(value: unknown): asserts value is WorkspaceConfig {
  if (!validateWorkspace(value)) throw new ConfigError("INVALID_CONFIGURATION", "Workspace failed schema validation", { issues: schemaIssues(validateWorkspace) });
  const root = normalizeAbsolutePath(value.root, { requireNormalized: true });
  for (const source of value.context_sources) {
    if ((source.kind === "file" || source.kind === "directory") && !source.uri.includes("://")) resolveContainedPath(root, source.uri);
  }
  if (containsSecret(value)) throw Object.assign(new Error("Workspace configuration appears to contain a secret value"), { code: "PRIVACY_DENIED" });
}

function assertProject(value: unknown): asserts value is ProjectManifest {
  if (!validateProject(value)) throw new ConfigError("INVALID_CONFIGURATION", "Project link failed schema validation", { issues: schemaIssues(validateProject) });
  if (value.additional_workspaces?.includes(value.workspace)) {
    throw new ConfigError("INVALID_CONFIGURATION", "Primary workspace cannot also be an additional workspace");
  }
  resolveContainedPath(value.root, value.context_index ?? ".pragman/context-index.yaml");
  if (containsSecret(value)) throw Object.assign(new Error("Project configuration appears to contain a secret value"), { code: "PRIVACY_DENIED" });
}

function workspaceDocument(value: WorkspaceConfig): WorkspaceConfig {
  const result: WorkspaceConfig = {
    schema_version: 1,
    workspace_id: value.workspace_id,
    name: value.name,
    root: value.root,
    context_sources: value.context_sources,
  };
  for (const key of ["description", "tools", "workflows", "sensitivity"] as const) {
    const selected = value[key];
    if (selected !== undefined) (result as JsonObject)[key] = selected;
  }
  return result;
}

function projectDocument(value: ProjectManifest): ProjectManifest {
  const result: ProjectManifest = {
    schema_version: 1,
    project_id: value.project_id,
    workspace: value.workspace,
    root: value.root,
  };
  for (const key of ["product", "additional_workspaces", "context_index"] as const) {
    const selected = value[key];
    if (selected !== undefined) (result as JsonObject)[key] = selected;
  }
  return result;
}

function yamlBytes(value: JsonObject): Uint8Array {
  return Buffer.from(stringify(value, { lineWidth: 0 }));
}

function createPreview(command: string, kind: "workspace" | "project", id: string, bytes: Uint8Array) {
  return {
    mutated: false,
    action: "create",
    target: { kind, id },
    base_digest: null,
    preview_digest: contentDigest(bytes),
    approval_classes: ["local-config-write"],
    expires_at: null,
    command,
  };
}

async function assertSafeParent(root: string, target: string): Promise<void> {
  resolveContainedPath(root, target);
  const rootReal = await realpath(root);
  let current = dirname(target);
  const pending: string[] = [];
  while (current !== root && current !== dirname(current)) {
    pending.push(current);
    current = dirname(current);
  }
  for (const candidate of pending.reverse()) {
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw Object.assign(new Error("Configuration path crosses a symbolic link"), { code: "PRIVACY_DENIED" });
      const candidateReal = await realpath(candidate);
      const relation = relative(rootReal, candidateReal);
      if (relation === ".." || relation.startsWith(`..${sep}`)) throw Object.assign(new Error("Configuration path escapes its selected root"), { code: "PRIVACY_DENIED" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function withLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lock = join(root, ".change-lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ConfigError("TEMPORARY_FAILURE", "Another configuration writer is active");
    throw error;
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function applyCreate(root: string, target: string, bytes: Uint8Array, expected: string): Promise<void> {
  if (contentDigest(bytes) !== expected) throw new ConfigError("STALE_PREVIEW", "Preview digest does not match the proposed content");
  await assertSafeParent(root, target);
  await withLock(root, async () => {
    try {
      await lstat(target);
      throw new ConfigError("STALE_PREVIEW", "Target was created after the preview");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWrite(target, bytes);
  });
}

function safeWorkspaceSummary(value: WorkspaceConfig) {
  return {
    workspace_id: value.workspace_id,
    name: value.name,
    sensitivity: typeof value.sensitivity === "string" ? value.sensitivity : "internal",
    context_source_count: value.context_sources.length,
  };
}

async function add(arguments_: CliArguments, io: CommandIo): Promise<CommandExecution> {
  const command = "workspace.add";
  const value = await readJson(arguments_, io);
  assertWorkspace(value);
  const root = personalRoot(arguments_);
  await loadPersonalConfig(root);
  const target = workspaceConfigPath(root, value.workspace_id);
  const bytes = yamlBytes(workspaceDocument(value));
  const preview = createPreview(command, "workspace", value.workspace_id, bytes);
  if (!arguments_.applyDigest) return execution(EXIT_CODES.success, successEnvelope(command, preview), `Preview workspace ${value.workspace_id}; apply digest ${preview.preview_digest}`);
  if (arguments_.applyDigest !== preview.preview_digest) throw new ConfigError("STALE_PREVIEW", "Apply digest does not match this preview");
  await applyCreate(root, target, bytes, arguments_.applyDigest);
  return execution(EXIT_CODES.success, successEnvelope(command, { ...preview, mutated: true }), `Added workspace ${value.workspace_id}`);
}

function parseEditInput(value: unknown): { operations: PatchOperation[]; reason: string } {
  if (!isObject(value) || !exactKeys(value, ["operations", "reason"]) || !Array.isArray(value.operations) || typeof value.reason !== "string" || !value.reason.trim()) {
    throw new ConfigError("INVALID_CONFIGURATION", "Edit input requires only operations and reason");
  }
  const operations: PatchOperation[] = value.operations.map((operation) => {
    if (!isObject(operation) || typeof operation.op !== "string" || typeof operation.path !== "string") {
      throw new ConfigError("INVALID_PATCH", "Every patch operation needs an op and path");
    }
    if (operation.op === "remove") {
      if (!exactKeys(operation, ["op", "path"])) throw new ConfigError("INVALID_PATCH", "Remove operations accept only op and path");
      return { op: "remove", path: operation.path };
    }
    if (operation.op === "add" || operation.op === "replace") {
      if (!exactKeys(operation, ["op", "path", "value"])) throw new ConfigError("INVALID_PATCH", "Add and replace operations require only op, path, and value");
      return { op: operation.op, path: operation.path, value: operation.value as JsonValue };
    }
    throw new ConfigError("INVALID_PATCH", "Patch op must be add, replace, or remove");
  });
  return { operations, reason: value.reason };
}

async function edit(arguments_: CliArguments, io: CommandIo): Promise<CommandExecution> {
  const command = "workspace.edit";
  if (!arguments_.workspace) throw Object.assign(new Error("--workspace is required"), { code: "NEEDS_INPUT" });
  const root = personalRoot(arguments_);
  await loadPersonalConfig(root);
  const before = await loadWorkspaceConfig(root, arguments_.workspace);
  const input = parseEditInput(await readJson(arguments_, io));
  if (input.operations.some((operation) => operation.path === "/workspace_id" || operation.path === "/root")) {
    throw new ConfigError("INVALID_PATCH", "workspace_id and root are immutable; create a new workspace instead");
  }
  const preview = await previewChange({
    stateRoot: root,
    targetPath: workspaceConfigPath(root, arguments_.workspace),
    target: "workspace",
    targetId: arguments_.workspace,
    operations: input.operations,
    reason: input.reason,
    validate(value: JsonValue) {
      assertWorkspace(value);
      if (value.workspace_id !== before.workspace_id || value.root !== before.root) throw new ConfigError("INVALID_PATCH", "Workspace identity and root cannot change");
    },
  });
  const approvalDigest = createHash("sha256")
    .update(`${preview.base_digest}\0${preview.preview_digest}\0${JSON.stringify(preview.operations)}`)
    .digest("hex");
  const data = {
    mutated: false,
    action: "edit",
    target: { kind: "workspace", id: arguments_.workspace },
    base_digest: preview.base_digest,
    preview_digest: approvalDigest,
    operations: preview.operations,
    approval_classes: ["local-config-write"],
    expires_at: null,
  };
  if (!arguments_.applyDigest) return execution(EXIT_CODES.success, successEnvelope(command, data), `Preview workspace ${arguments_.workspace} edit; apply digest ${approvalDigest}`);
  if (arguments_.applyDigest !== approvalDigest) throw new ConfigError("STALE_PREVIEW", "Apply digest does not match the current target and proposed content");
  const applied = await applyChange(preview, preview.preview_digest);
  return execution(EXIT_CODES.success, successEnvelope(command, { ...data, mutated: true, change_id: applied.record.change_id }), `Edited workspace ${arguments_.workspace}`);
}

async function list(arguments_: CliArguments): Promise<CommandExecution> {
  const command = "workspace.list";
  const root = personalRoot(arguments_);
  await loadPersonalConfig(root);
  const directory = join(root, "workspaces");
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
    else throw error;
  }
  const workspaces: ReturnType<typeof safeWorkspaceSummary>[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw Object.assign(new Error("Workspace registry contains a symbolic link"), { code: "PRIVACY_DENIED" });
    if (!entry.isDirectory()) continue;
    workspaces.push(safeWorkspaceSummary(await loadWorkspaceConfig(root, entry.name)));
  }
  return execution(EXIT_CODES.success, successEnvelope(command, { workspaces }), `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}`);
}

function parseLinkInput(value: unknown, projectRoot: string): ProjectManifest {
  if (!isObject(value) || !exactKeys(value, ["project_id", "workspace"], ["additional_workspaces", "product", "context_index"])) {
    throw new ConfigError("INVALID_CONFIGURATION", "Link input contains unsupported or missing fields");
  }
  const result = projectDocument({ schema_version: 1, root: projectRoot, ...value } as ProjectManifest);
  assertProject(result);
  return result;
}

async function linkProject(arguments_: CliArguments, io: CommandIo): Promise<CommandExecution> {
  const command = "workspace.link";
  if (!arguments_.projectRoot) throw Object.assign(new Error("--project-root is required"), { code: "NEEDS_INPUT" });
  const projectRoot = normalizeAbsolutePath(arguments_.projectRoot);
  const root = personalRoot(arguments_);
  await loadPersonalConfig(root);
  const manifest = parseLinkInput(await readJson(arguments_, io), projectRoot);
  await loadWorkspaceConfig(root, manifest.workspace);
  for (const id of manifest.additional_workspaces ?? []) await loadWorkspaceConfig(root, id);
  const target = projectManifestPath(projectRoot);
  const bytes = yamlBytes(manifest);
  const preview = createPreview(command, "project", manifest.project_id, bytes);
  if (!arguments_.applyDigest) return execution(EXIT_CODES.success, successEnvelope(command, preview), `Preview project ${manifest.project_id} link; apply digest ${preview.preview_digest}`);
  if (arguments_.applyDigest !== preview.preview_digest) throw new ConfigError("STALE_PREVIEW", "Apply digest does not match this preview");
  await applyCreate(projectRoot, target, bytes, arguments_.applyDigest);
  return execution(EXIT_CODES.success, successEnvelope(command, { ...preview, mutated: true }), `Linked project ${manifest.project_id} to ${manifest.workspace}`);
}

async function unlinkProject(arguments_: CliArguments): Promise<CommandExecution> {
  const command = "workspace.unlink";
  if (!arguments_.projectRoot) throw Object.assign(new Error("--project-root is required"), { code: "NEEDS_INPUT" });
  const projectRoot = normalizeAbsolutePath(arguments_.projectRoot);
  await loadPersonalConfig(personalRoot(arguments_));
  const target = projectManifestPath(projectRoot);
  const manifest = await loadProjectManifest(projectRoot);
  const current = await readFile(target);
  const baseDigest = contentDigest(current);
  const previewDigest = createHash("sha256").update(`unlink\0${baseDigest}`).digest("hex");
  const data = {
    mutated: false,
    action: "unlink",
    target: { kind: "project", id: manifest.project_id },
    base_digest: baseDigest,
    preview_digest: previewDigest,
    approval_classes: ["local-config-delete"],
    expires_at: null,
  };
  if (!arguments_.applyDigest) return execution(EXIT_CODES.success, successEnvelope(command, data), `Preview unlink for project ${manifest.project_id}; apply digest ${previewDigest}`);
  if (arguments_.applyDigest !== previewDigest) throw new ConfigError("STALE_PREVIEW", "Apply digest does not match this preview");
  await assertSafeParent(projectRoot, target);
  await withLock(projectRoot, async () => {
    const fresh = await readFile(target);
    if (contentDigest(fresh) !== baseDigest) throw new ConfigError("STALE_PREVIEW", "Project link changed after preview");
    const snapshots = join(projectRoot, ".pragman", "history", "unlinked");
    await assertSafeParent(projectRoot, join(snapshots, "snapshot.yaml"));
    await mkdir(snapshots, { recursive: true });
    await rename(target, join(snapshots, `${baseDigest}-${randomUUID()}.yaml`));
  });
  return execution(EXIT_CODES.success, successEnvelope(command, { ...data, mutated: true }), `Unlinked project ${manifest.project_id}`);
}

function sanitizedContextSources(value: JsonValue | undefined): Array<{ id: string; sensitivity: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((source) => isObject(source) && typeof source.id === "string"
    ? [{ id: source.id, sensitivity: typeof source.sensitivity === "string" ? source.sensitivity : "internal" }]
    : []);
}

async function validate(arguments_: CliArguments): Promise<CommandExecution> {
  const command = "workspace.validate";
  const root = personalRoot(arguments_);
  const context = await loadConfigurationContext({
    personalRoot: root,
    ...(arguments_.workspace ? { workspaceId: arguments_.workspace } : {}),
    ...(arguments_.projectRoot ? { projectRoot: arguments_.projectRoot } : {}),
  });
  const merged = mergeConfiguration({
    personal: context.personal,
    ...(context.primaryWorkspace ? { primaryWorkspace: context.primaryWorkspace } : {}),
    ...(context.project ? { project: context.project } : {}),
    additionalWorkspaces: context.additionalWorkspaces.map((workspace) => ({ workspaceId: workspace.workspace_id, value: workspace })),
  });
  const data = {
    valid: true,
    mode: context.mode,
    primary_workspace: context.primaryWorkspace?.workspace_id ?? null,
    project: context.project?.project_id ?? null,
    additional_workspaces: context.additionalWorkspaces.map((workspace) => workspace.workspace_id),
    context_sources: sanitizedContextSources(merged.value.context_sources),
    provenance: merged.provenance,
    conflicts: merged.additionalWorkspaceConflicts.map((conflict) => ({
      path: conflict.path,
      workspace_ids: conflict.values.map((entry) => entry.workspaceId),
      requires_choice: true,
    })),
    routing_candidates: merged.additionalRoutingCandidates.map((candidate) => ({ workspace_id: candidate.workspaceId, rule_id: candidate.rule.id, advisory: true })),
  };
  return execution(EXIT_CODES.success, successEnvelope(command, data), `${context.mode} configuration is valid`);
}

function mapError(command: string, error: unknown): CommandExecution {
  const code = error instanceof ConfigError ? error.code : isObject(error) && typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "Workspace command failed";
  if (code === "NEEDS_INPUT") return fail(command, EXIT_CODES.needsInput, code, message);
  if (code === "PRIVACY_DENIED") return fail(command, EXIT_CODES.denied, code, message);
  if (code === "STALE_PREVIEW") return fail(command, EXIT_CODES.denied, code, message);
  if (code === "TEMPORARY_FAILURE") return fail(command, EXIT_CODES.temporary, code, message, null, true);
  if (code === "NOT_FOUND" || code === "INVALID_CONFIGURATION" || code === "INVALID_PATCH" || code === "INVALID_PATH" || code === "INCOMPATIBLE_VERSION" || code === "WORKSPACE_MISMATCH") {
    return fail(command, EXIT_CODES.invalid, code, message, error instanceof ConfigError ? error.details : null);
  }
  return fail(command, EXIT_CODES.internal, "INTERNAL_ERROR", "Workspace command failed");
}

export async function executeWorkspaceCommand(arguments_: CliArguments, io: CommandIo): Promise<CommandExecution> {
  try {
    switch (arguments_.command) {
      case "workspace.add": return await add(arguments_, io);
      case "workspace.edit": return await edit(arguments_, io);
      case "workspace.list": return await list(arguments_);
      case "workspace.link": return await linkProject(arguments_, io);
      case "workspace.unlink": return await unlinkProject(arguments_);
      case "workspace.validate": return await validate(arguments_);
      default: return fail(arguments_.command, EXIT_CODES.invalid, "INVALID_INPUT", "Unsupported workspace command");
    }
  } catch (error) {
    return mapError(arguments_.command, error);
  }
}

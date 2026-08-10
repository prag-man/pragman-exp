import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import personalSchema from "../../../config/schemas/personal-config.schema.json" with { type: "json" };
import projectSchema from "../../../config/schemas/project.schema.json" with { type: "json" };
import workspaceSchema from "../../../config/schemas/workspace.schema.json" with { type: "json" };
import { applyChange, contentDigest, ConfigError, normalizeAbsolutePath, personalConfigPath, previewChange, projectManifestPath, rollbackChange, workspaceConfigPath, type ChangeRecord, type ChangeTarget, type JsonValue, type PatchOperation } from "../../../config/src/index.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution, CommandIo } from "./events.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true, removeAdditional: false, coerceTypes: false });
const validators: Record<ChangeTarget, ValidateFunction> = {
  personal: ajv.compile(personalSchema), workspace: ajv.compile(workspaceSchema), project: ajv.compile(projectSchema),
};
const TARGETS = new Set<ChangeTarget>(["personal", "workspace", "project"]);
const MAX_JOURNAL_BYTES = 10 * 1024 * 1024;
const MAX_RECORDS = 10_000;

function stateRoot(arguments_: CliArguments): string { return normalizeAbsolutePath(arguments_.config ?? join(homedir(), ".pragman")); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function failure(command: string, error: unknown): CommandExecution {
  const code = error instanceof ConfigError ? error.code : typeof error === "object" && error !== null && "code" in error ? String(error.code) : "INTERNAL";
  const message = error instanceof Error ? error.message : "Change operation failed";
  const exitCode = code === "NEEDS_INPUT" ? EXIT_CODES.needsInput : code === "STALE_PREVIEW" || code === "PRIVACY_DENIED" ? EXIT_CODES.denied
    : code === "TEMPORARY_FAILURE" ? EXIT_CODES.temporary : code === "INTERNAL" ? EXIT_CODES.internal : EXIT_CODES.invalid;
  return { exitCode, envelope: errorEnvelope(command, code, message), human: message, stderr: true };
}

async function input(arguments_: CliArguments, io: CommandIo): Promise<unknown> {
  const raw = arguments_.file ? await readFile(arguments_.file, "utf8") : await io.readStdin();
  if (!raw.trim()) throw Object.assign(new Error("Change JSON is required"), { code: "NEEDS_INPUT" });
  try { return JSON.parse(raw) as unknown; } catch { throw new ConfigError("INVALID_CONFIGURATION", "Change input must be valid JSON"); }
}

function operations(value: unknown): PatchOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new ConfigError("INVALID_PATCH", "Change requires 1-100 patch operations");
  return value.map((entry) => {
    if (!object(entry) || typeof entry.op !== "string" || typeof entry.path !== "string") throw new ConfigError("INVALID_PATCH", "Patch operation is invalid");
    const keys = Object.keys(entry).sort().join(",");
    if (entry.op === "remove" && keys === "op,path") return { op: "remove", path: entry.path };
    if ((entry.op === "add" || entry.op === "replace") && keys === "op,path,value") return { op: entry.op, path: entry.path, value: entry.value as JsonValue };
    throw new ConfigError("INVALID_PATCH", "Only exact add, replace, and remove operations are supported");
  });
}

function selection(arguments_: CliArguments, value?: unknown): { target: ChangeTarget; targetId: string; operations?: PatchOperation[]; reason?: string; evidenceRefs?: string[] } {
  const record = object(value) ? value : {};
  const target = String(record.target ?? arguments_.target ?? "");
  const targetId = String(record.target_id ?? arguments_.targetId ?? "");
  if (!TARGETS.has(target as ChangeTarget) || !targetId) throw Object.assign(new Error("target and target_id are required"), { code: "NEEDS_INPUT" });
  if (value === undefined) return { target: target as ChangeTarget, targetId };
  const allowed = new Set(["target", "target_id", "operations", "reason", "evidence_refs"]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || typeof record.reason !== "string" || !record.reason.trim()
    || (record.evidence_refs !== undefined && (!Array.isArray(record.evidence_refs) || !record.evidence_refs.every((entry) => typeof entry === "string")))) {
    throw new ConfigError("INVALID_CONFIGURATION", "Change input fields are invalid");
  }
  return { target: target as ChangeTarget, targetId, operations: operations(record.operations), reason: record.reason, evidenceRefs: (record.evidence_refs as string[] | undefined) ?? [] };
}

function targetPath(arguments_: CliArguments, target: ChangeTarget, targetId: string): string {
  const root = stateRoot(arguments_);
  if (target === "personal") return personalConfigPath(root);
  if (target === "workspace") return workspaceConfigPath(root, targetId);
  if (!arguments_.projectRoot) throw Object.assign(new Error("--project-root is required for project changes"), { code: "NEEDS_INPUT" });
  return projectManifestPath(arguments_.projectRoot);
}

function validateTarget(target: ChangeTarget, value: JsonValue): void {
  const validator = validators[target];
  if (!validator(value)) throw new ConfigError("INVALID_CONFIGURATION", "Proposed target fails schema validation", { issues: validator.errors ?? [] });
}

function publicPreview(preview: Awaited<ReturnType<typeof previewChange>>, mutated = false) {
  return {
    schema_version: preview.schema_version, change_id: preview.change_id, target: preview.target, target_id: preview.target_id,
    base_digest: preview.base_digest, preview_digest: preview.preview_digest, operations: preview.operations, reason: preview.reason,
    evidence_refs: preview.evidence_refs, approval_classes: ["local-config-write"], mutated,
  };
}

async function journal(arguments_: CliArguments): Promise<ChangeRecord[]> {
  const path = join(stateRoot(arguments_), "history", "changes.jsonl");
  let raw: string;
  try { raw = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (Buffer.byteLength(raw) > MAX_JOURNAL_BYTES) throw new ConfigError("INVALID_CONFIGURATION", "Change journal exceeds bounded read limit");
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length > MAX_RECORDS) throw new ConfigError("INVALID_CONFIGURATION", "Change journal exceeds record limit");
  return lines.map((line) => JSON.parse(line) as ChangeRecord);
}

export async function executeChangesCommand(arguments_: CliArguments, io: CommandIo): Promise<CommandExecution> {
  const command = arguments_.command;
  try {
    if (command === "changes.list") {
      const records = await journal(arguments_);
      return { exitCode: EXIT_CODES.success, envelope: successEnvelope(command, { changes: records }), human: `${records.length} change records.`, stderr: false };
    }
    if (command === "changes.rollback") {
      if (!arguments_.change) throw Object.assign(new Error("--change is required"), { code: "NEEDS_INPUT" });
      const applied = (await journal(arguments_)).find((record) => record.change_id === arguments_.change);
      if (!applied) throw new ConfigError("NOT_FOUND", "Change record was not found");
      const target = targetPath(arguments_, applied.target, applied.target_id);
      const current = await readFile(target);
      const previewDigest = contentDigest(JSON.stringify({ change_id: applied.change_id, current: contentDigest(current), snapshot: applied.rollback.snapshot_ref }));
      const preview = { change_id: applied.change_id, target: applied.target, target_id: applied.target_id, preview_digest: previewDigest, approval_classes: ["local-config-write"], mutated: false };
      if (!arguments_.applyDigest) return { exitCode: EXIT_CODES.success, envelope: successEnvelope(command, preview), human: `Preview rollback ${applied.change_id}; apply digest ${previewDigest}.`, stderr: false };
      if (arguments_.applyDigest !== previewDigest) throw new ConfigError("STALE_PREVIEW", "Rollback approval digest is stale");
      const result = await rollbackChange(applied, { stateRoot: stateRoot(arguments_), targetPath: target });
      return { exitCode: EXIT_CODES.success, envelope: successEnvelope(command, { ...preview, change_id: result.record.change_id, rolled_back_change_id: applied.change_id, mutated: true }), human: `Rolled back ${applied.change_id}.`, stderr: false };
    }
    const selected = selection(arguments_, await input(arguments_, io));
    const preview = await previewChange({
      stateRoot: stateRoot(arguments_), targetPath: targetPath(arguments_, selected.target, selected.targetId), target: selected.target,
      targetId: selected.targetId, operations: selected.operations!, reason: selected.reason!, evidenceRefs: selected.evidenceRefs ?? [],
      validate: (value) => validateTarget(selected.target, value),
    });
    if (command === "changes.preview") return { exitCode: EXIT_CODES.success, envelope: successEnvelope(command, publicPreview(preview)), human: `Preview ${preview.change_id}; apply digest ${preview.preview_digest}.`, stderr: false };
    if (!arguments_.applyDigest) throw Object.assign(new Error("--apply with the unchanged preview digest is required"), { code: "NEEDS_INPUT" });
    const applied = await applyChange(preview, arguments_.applyDigest);
    return { exitCode: EXIT_CODES.success, envelope: successEnvelope(command, { ...publicPreview(preview, true), change_id: applied.record.change_id }), human: `Applied change ${applied.record.change_id}.`, stderr: false };
  } catch (error) {
    return failure(command, error);
  }
}

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse, stringify } from "yaml";

import { atomicWrite } from "./atomic-write.ts";
import { normalizeAbsolutePath, resolveContainedPath } from "./paths.ts";
import { ConfigError, type AppliedChange, type ChangePreview, type ChangeRecord, type ChangeTarget, type JsonObject, type JsonValue, type PatchOperation } from "./types.ts";

const FORBIDDEN_POINTER_PARTS = new Set(["__proto__", "prototype", "constructor"]);

export function contentDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function uuidV7(): string {
  const bytes = randomBytes(16);
  let milliseconds = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = milliseconds & 0xff;
    milliseconds = Math.floor(milliseconds / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decodePointer(path: string): string[] {
  if (!path.startsWith("/") || path === "/") throw new ConfigError("INVALID_PATCH", "Patch paths must address a non-root field");
  const parts = path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.some((part) => FORBIDDEN_POINTER_PARTS.has(part))) throw new ConfigError("INVALID_PATCH", "Unsafe patch path");
  return parts;
}

function own(container: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(container, key);
}

function applyOperation(document: JsonValue, operation: PatchOperation): void {
  const parts = decodePointer(operation.path);
  let parent: JsonValue = document;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(parent)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new ConfigError("INVALID_PATCH", "Patch path does not exist");
      parent = parent[index]!;
    } else if (parent !== null && typeof parent === "object" && own(parent, part)) {
      parent = parent[part]!;
    } else {
      throw new ConfigError("INVALID_PATCH", "Patch path does not exist");
    }
  }
  const key = parts.at(-1)!;
  if (Array.isArray(parent)) {
    if (operation.op === "add") {
      const index = key === "-" ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new ConfigError("INVALID_PATCH", "Invalid array insertion index");
      parent.splice(index, 0, structuredClone(operation.value));
      return;
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new ConfigError("INVALID_PATCH", "Patch path does not exist");
    if (operation.op === "remove") parent.splice(index, 1);
    else parent[index] = structuredClone(operation.value);
    return;
  }
  if (parent === null || typeof parent !== "object") throw new ConfigError("INVALID_PATCH", "Patch parent is not a container");
  const exists = own(parent, key);
  if ((operation.op === "replace" || operation.op === "remove") && !exists) throw new ConfigError("INVALID_PATCH", "Patch path does not exist");
  if (operation.op === "remove") delete parent[key];
  else parent[key] = structuredClone(operation.value);
}

export function applyPatch(value: JsonValue, operations: readonly PatchOperation[]): JsonValue {
  const result = structuredClone(value);
  for (const operation of operations) applyOperation(result, operation);
  return result;
}

function parseDocument(path: string, bytes: Uint8Array): JsonValue {
  try {
    const text = Buffer.from(bytes).toString("utf8");
    return (extname(path).toLowerCase() === ".json" ? JSON.parse(text) : parse(text, { uniqueKeys: true })) as JsonValue;
  } catch {
    throw new ConfigError("INVALID_CONFIGURATION", "Target configuration cannot be parsed");
  }
}

function serializeDocument(path: string, value: JsonValue): Uint8Array {
  const text = extname(path).toLowerCase() === ".json"
    ? `${JSON.stringify(value, null, 2)}\n`
    : stringify(value, { lineWidth: 0 });
  return Buffer.from(text);
}

function assertTargetContained(stateRoot: string, targetPath: string): { root: string; target: string } {
  const root = normalizeAbsolutePath(stateRoot);
  const target = normalizeAbsolutePath(targetPath);
  resolveContainedPath(root, target);
  return { root, target };
}

async function withChangeLock<T>(stateRoot: string, action: () => Promise<T>): Promise<T> {
  const lockPath = join(stateRoot, ".change-lock");
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ConfigError("TEMPORARY_FAILURE", "Another configuration writer is active");
    throw error;
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function appendJournal(root: string, record: ChangeRecord): Promise<void> {
  const path = join(root, "history", "changes.jsonl");
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWrite(path, `${current}${JSON.stringify(record)}\n`);
}

async function preserveSnapshot(root: string, digest: string, bytes: Uint8Array): Promise<string> {
  const path = join(root, "history", "snapshots", `${digest}.bin`);
  try {
    const existing = await readFile(path);
    if (contentDigest(existing) !== digest) throw new ConfigError("INVALID_CONFIGURATION", "Existing snapshot failed its digest check");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(path, bytes);
  }
  return path;
}

export async function previewChange(options: {
  stateRoot: string;
  targetPath: string;
  target: ChangeTarget;
  targetId: string;
  operations: PatchOperation[];
  reason: string;
  evidenceRefs?: string[];
  validate?: (value: JsonValue) => void;
  now?: Date;
}): Promise<ChangePreview> {
  const { root, target } = assertTargetContained(options.stateRoot, options.targetPath);
  const currentBytes = await readFile(target);
  const current = parseDocument(target, currentBytes);
  const proposed = applyPatch(current, options.operations);
  options.validate?.(proposed);
  const proposedBytes = serializeDocument(target, proposed);
  const approvedAt = (options.now ?? new Date()).toISOString();
  return {
    schema_version: 1,
    change_id: uuidV7(),
    target: options.target,
    target_id: options.targetId,
    base_digest: contentDigest(currentBytes),
    preview_digest: contentDigest(proposedBytes),
    operations: structuredClone(options.operations),
    reason: options.reason,
    evidence_refs: [...(options.evidenceRefs ?? [])],
    approved_by: "local-user",
    approved_at: approvedAt,
    applied_at: null,
    rollback: { available: true, snapshot_ref: contentDigest(currentBytes), rolled_back_at: null },
    stateRoot: root,
    targetPath: target,
    proposedBytes,
  };
}

export async function applyChange(preview: ChangePreview, expectedPreviewDigest = preview.preview_digest): Promise<AppliedChange> {
  const { root, target } = assertTargetContained(preview.stateRoot, preview.targetPath);
  if (expectedPreviewDigest !== preview.preview_digest || contentDigest(preview.proposedBytes) !== preview.preview_digest) {
    throw new ConfigError("STALE_PREVIEW", "Preview digest does not match the approved content");
  }
  return withChangeLock(root, async () => {
    const currentBytes = await readFile(target);
    if (contentDigest(currentBytes) !== preview.base_digest) throw new ConfigError("STALE_PREVIEW", "Target changed after the preview was created");
    const recomputed = serializeDocument(target, applyPatch(parseDocument(target, currentBytes), preview.operations));
    if (contentDigest(recomputed) !== preview.preview_digest) throw new ConfigError("STALE_PREVIEW", "Preview no longer reproduces the approved content");
    const snapshotPath = await preserveSnapshot(root, preview.base_digest, currentBytes);
    await atomicWrite(target, preview.proposedBytes);
    const record: ChangeRecord = { ...preview, applied_at: new Date().toISOString() };
    delete (record as Partial<ChangePreview>).stateRoot;
    delete (record as Partial<ChangePreview>).targetPath;
    delete (record as Partial<ChangePreview>).proposedBytes;
    await appendJournal(root, record);
    return { record, snapshotPath };
  });
}

export async function rollbackChange(
  applied: ChangeRecord,
  options: { stateRoot: string; targetPath: string; now?: Date },
): Promise<AppliedChange> {
  const { root, target } = assertTargetContained(options.stateRoot, options.targetPath);
  if (!applied.applied_at || !applied.rollback.available) throw new ConfigError("INVALID_CONFIGURATION", "Change is not rollbackable");
  return withChangeLock(root, async () => {
    const currentBytes = await readFile(target);
    if (contentDigest(currentBytes) !== applied.preview_digest) throw new ConfigError("STALE_PREVIEW", "Target changed after the applied change");
    const snapshotPath = join(root, "history", "snapshots", `${applied.rollback.snapshot_ref}.bin`);
    const snapshot = await readFile(snapshotPath);
    if (contentDigest(snapshot) !== applied.base_digest || applied.rollback.snapshot_ref !== applied.base_digest) {
      throw new ConfigError("INVALID_CONFIGURATION", "Rollback snapshot failed its digest check");
    }
    await atomicWrite(target, snapshot);
    const now = (options.now ?? new Date()).toISOString();
    const record: ChangeRecord = {
      schema_version: 1,
      change_id: uuidV7(),
      target: applied.target,
      target_id: applied.target_id,
      base_digest: applied.preview_digest,
      preview_digest: applied.base_digest,
      operations: [],
      reason: `Rollback ${applied.change_id}`,
      evidence_refs: [`change:${applied.change_id}`],
      approved_by: "local-user",
      approved_at: now,
      applied_at: now,
      rollback: { available: true, snapshot_ref: applied.preview_digest, rolled_back_at: now },
    };
    const rollbackSnapshotPath = await preserveSnapshot(root, applied.preview_digest, currentBytes);
    await appendJournal(root, record);
    return { record, snapshotPath: rollbackSnapshotPath };
  });
}

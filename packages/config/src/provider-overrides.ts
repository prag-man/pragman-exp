import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { stringify, parse } from "yaml";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import providerOverridesSchema from "../schemas/provider-overrides.schema.json" with { type: "json" };
import { atomicWrite } from "./atomic-write.ts";
import { contentDigest } from "./changes.ts";
import { normalizeAbsolutePath, resolveContainedPath } from "./paths.ts";
import { ConfigError, type ChangeRecord, type PatchOperation } from "./types.ts";

export interface ProviderTrustRecord {
  provider_id: string;
  source: string;
  source_version: string;
  digest: string;
  reviewed_at: string;
}

export interface ProviderOverrides {
  schema_version: 1;
  prefer: string[];
  trust: ProviderTrustRecord[];
}

export interface ProviderOverridesChangePreview {
  record: ChangeRecord;
  base_existed: boolean;
  state_root: string;
  target_path: string;
  proposed_bytes: Uint8Array;
}

export interface AppliedProviderOverridesChange {
  record: ChangeRecord;
  snapshot_path: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, removeAdditional: false, coerceTypes: false });
const addFormats = ("default" in formatsModule ? formatsModule.default : formatsModule) as unknown as FormatsPlugin;
addFormats(ajv);
const validateSchema = ajv.compile(providerOverridesSchema) as ValidateFunction<ProviderOverrides>;

function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let milliseconds = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = milliseconds & 0xff;
    milliseconds = Math.floor(milliseconds / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function emptyOverrides(): ProviderOverrides {
  return { schema_version: 1, prefer: [], trust: [] };
}

function schemaIssues(): string[] {
  return (validateSchema.errors ?? []).map((issue) => `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}`);
}

export function validateProviderOverrides(value: unknown): ProviderOverrides {
  if (!validateSchema(value)) {
    throw new ConfigError("INVALID_CONFIGURATION", "Provider overrides failed schema validation", { issues: schemaIssues() });
  }
  const providerIds = new Set<string>();
  for (const record of value.trust) {
    if (providerIds.has(record.provider_id)) {
      throw new ConfigError("INVALID_CONFIGURATION", "Provider trust bindings must have unique provider IDs", { provider_id: record.provider_id });
    }
    providerIds.add(record.provider_id);
  }
  return structuredClone(value);
}

export function providerOverridesPath(personalRoot: string): string {
  const root = normalizeAbsolutePath(personalRoot);
  return resolveContainedPath(root, join(root, "providers.yaml"));
}

function serialize(value: ProviderOverrides): Uint8Array {
  return Buffer.from(stringify(value, { lineWidth: 0 }));
}

async function readExisting(root: string): Promise<{ value: ProviderOverrides; bytes: Uint8Array; existed: boolean }> {
  const path = providerOverridesPath(root);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ConfigError("INVALID_PATH", "Provider overrides must be a regular private file");
    }
    const bytes = await readFile(path);
    let value: unknown;
    try {
      value = parse(bytes.toString("utf8"), { uniqueKeys: true });
    } catch {
      throw new ConfigError("INVALID_CONFIGURATION", "Provider overrides cannot be parsed");
    }
    return { value: validateProviderOverrides(value), bytes, existed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const value = emptyOverrides();
    return { value, bytes: serialize(value), existed: false };
  }
}

export async function loadProviderOverrides(personalRoot: string): Promise<ProviderOverrides> {
  return (await readExisting(normalizeAbsolutePath(personalRoot))).value;
}

function operationsBetween(current: ProviderOverrides, next: ProviderOverrides): PatchOperation[] {
  const operations: PatchOperation[] = [];
  if (JSON.stringify(current.prefer) !== JSON.stringify(next.prefer)) {
    operations.push({ op: "replace", path: "/prefer", value: structuredClone(next.prefer) });
  }
  if (JSON.stringify(current.trust) !== JSON.stringify(next.trust)) {
    operations.push({ op: "replace", path: "/trust", value: structuredClone(next.trust) as never });
  }
  return operations;
}

export async function previewProviderOverridesChange(options: {
  personalRoot: string;
  next: ProviderOverrides;
  reason: string;
  evidenceRefs?: string[];
  now?: Date;
}): Promise<ProviderOverridesChangePreview> {
  const root = normalizeAbsolutePath(options.personalRoot);
  const current = await readExisting(root);
  const next = validateProviderOverrides(options.next);
  const proposedBytes = serialize(next);
  const approvedAt = (options.now ?? new Date()).toISOString();
  const record: ChangeRecord = {
    schema_version: 1,
    change_id: uuidV7((options.now ?? new Date()).getTime()),
    target: "personal",
    target_id: "provider-overrides",
    base_digest: contentDigest(current.bytes),
    preview_digest: contentDigest(proposedBytes),
    operations: operationsBetween(current.value, next),
    reason: options.reason,
    evidence_refs: [...(options.evidenceRefs ?? [])],
    approved_by: "local-user",
    approved_at: approvedAt,
    applied_at: null,
    rollback: { available: true, snapshot_ref: contentDigest(current.bytes), rolled_back_at: null },
  };
  return {
    record,
    base_existed: current.existed,
    state_root: root,
    target_path: providerOverridesPath(root),
    proposed_bytes: proposedBytes,
  };
}

async function withChangeLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new ConfigError("INVALID_PATH", "Personal configuration root must be a regular directory");
  }
  const lockPath = join(root, ".change-lock");
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConfigError("TEMPORARY_FAILURE", "Another configuration writer is active");
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function preserveSnapshot(root: string, digest: string, bytes: Uint8Array): Promise<string> {
  const path = resolveContainedPath(root, join(root, "history", "snapshots", `${digest}.bin`));
  try {
    const existing = await readFile(path);
    if (contentDigest(existing) !== digest) {
      throw new ConfigError("INVALID_CONFIGURATION", "Existing provider snapshot failed its digest check");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(path, bytes);
  }
  return path;
}

async function appendJournal(root: string, record: ChangeRecord): Promise<void> {
  const path = resolveContainedPath(root, join(root, "history", "changes.jsonl"));
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWrite(path, `${existing}${JSON.stringify(record)}\n`);
}

export async function applyProviderOverridesChange(
  preview: ProviderOverridesChangePreview,
  expectedPreviewDigest = preview.record.preview_digest,
  now = new Date(),
): Promise<AppliedProviderOverridesChange> {
  const root = normalizeAbsolutePath(preview.state_root);
  const target = providerOverridesPath(root);
  if (target !== preview.target_path || expectedPreviewDigest !== preview.record.preview_digest
    || contentDigest(preview.proposed_bytes) !== preview.record.preview_digest) {
    throw new ConfigError("STALE_PREVIEW", "Provider preview digest does not match the approved content");
  }
  validateProviderOverrides(parse(Buffer.from(preview.proposed_bytes).toString("utf8"), { uniqueKeys: true }));
  return withChangeLock(root, async () => {
    const current = await readExisting(root);
    if (current.existed !== preview.base_existed || contentDigest(current.bytes) !== preview.record.base_digest) {
      throw new ConfigError("STALE_PREVIEW", "Provider overrides changed after the preview was created");
    }
    const snapshotPath = await preserveSnapshot(root, preview.record.base_digest, current.bytes);
    await atomicWrite(target, preview.proposed_bytes);
    const record: ChangeRecord = { ...preview.record, applied_at: now.toISOString() };
    await appendJournal(root, record);
    return { record, snapshot_path: snapshotPath };
  });
}

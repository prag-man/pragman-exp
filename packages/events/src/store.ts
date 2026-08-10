import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { channel } from "node:diagnostics_channel";

import { canonicalJson, sha256Digest } from "./canonical.ts";
import { createLifecycleIndex, type LifecycleMutationResult, type LifecycleReason } from "./lifecycle.ts";
import {
  EventStoreError,
  resolveContainedDirectory,
  resolveContainedFile,
  resolvePartitionPath,
  resolveStateRoot,
  type DurableRecordType,
} from "./paths.ts";
import type { EvalCandidate, EvalCandidateApproval, SkillEvent, SkillScore } from "./types.ts";
import { validateDurableRecordSchema } from "./validation.ts";

export type DurableRecord = SkillEvent | SkillScore | EvalCandidate | EvalCandidateApproval;
export type QuarantineReason = "IDENTITY_COLLISION" | "MALFORMED_TAIL" | "SCHEMA_INVALID" | LifecycleReason;

export type AppendResult =
  | { status: "appended" | "duplicate"; digest: string; partitionPath: string; reason: null }
  | { status: "quarantined"; digest: string; partitionPath: string; reason: QuarantineReason }
  | { status: "rejected"; digest: string; partitionPath: string; reason: LifecycleReason };

export interface QuarantinedRecord {
  reason: QuarantineReason;
  line: number;
  fileName: string;
}

export interface ReadPartitionResult<T> {
  records: T[];
  quarantined: QuarantinedRecord[];
}

interface ParsedPartitionResult<T> extends ReadPartitionResult<T> {
  repaired: boolean;
}

interface MutationLock {
  release(): Promise<void>;
}

export interface MutationOptions {
  lockTimeoutMs?: number;
}

export type BestEffortReason = "VALIDATION_FAILED" | "LOCK_TIMEOUT" | "DEADLINE_EXCEEDED" | "IO_ERROR";

export interface BestEffortLock {
  release(): Promise<void>;
}

export interface BestEffortDependencies {
  now(): number;
  delay(milliseconds: number): Promise<void>;
  acquireLock(lockBudgetMs: number): Promise<BestEffortLock | null>;
  appendUnlocked(record: SkillEvent): Promise<void>;
}

export interface BestEffortPolicy {
  lockBudgetMs: number;
  totalBudgetMs: number;
}

export interface BestEffortResult {
  recorded: boolean;
  reason: BestEffortReason | null;
}

export interface EventStateTransaction {
  readonly root: string;
  readPartition<T>(recordType: DurableRecordType, date: string): Promise<ReadPartitionResult<T>>;
  mutate(recordType: DurableRecordType, record: DurableRecord, options?: { sync?: boolean }): Promise<AppendResult>;
}

interface LockMetadata {
  schema_version: 1;
  owner_pid: number;
  owner_started_at: string;
  owner_process_start_identity: string;
  owner_token: string;
}

const ID_FIELDS: Record<DurableRecordType, string> = {
  "skill-events": "event_id",
  scores: "score_id",
  "eval-candidates": "candidate_id",
  "candidate-approvals": "approval_id",
};
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const STALE_INVALID_LOCK_MS = 30_000;
export const EVENT_STATE_REPLACEMENT_TARGETS = [
  "skill-events", "scores", "eval-candidates", "candidate-approvals", "quarantine", "rollups",
] as const;

interface ReplacementMarker {
  schema_version: 1;
  transaction_id: string;
  targets: typeof EVENT_STATE_REPLACEMENT_TARGETS;
}

const storeIoChannel = channel("pragman.events.store.io");

function observeStoreIo(operation: "read" | "write", path: string): void {
  if (storeIoChannel.hasSubscribers) storeIoChannel.publish({ operation, path });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

const SELF_PROCESS_START_IDENTITY = `epoch-second:${Math.floor((Date.now() - process.uptime() * 1_000) / 1_000)}`;

function currentLockMetadata(): LockMetadata {
  return {
    schema_version: 1,
    owner_pid: process.pid,
    owner_started_at: new Date().toISOString(),
    owner_process_start_identity: SELF_PROCESS_START_IDENTITY,
    owner_token: randomUUID(),
  };
}

function parseLockMetadata(value: string): LockMetadata | null {
  try {
    const parsed = JSON.parse(value) as Partial<LockMetadata>;
    return parsed.schema_version === 1
      && Number.isSafeInteger(parsed.owner_pid) && (parsed.owner_pid ?? 0) > 0
      && typeof parsed.owner_started_at === "string"
      && typeof parsed.owner_process_start_identity === "string" && parsed.owner_process_start_identity.length > 0
      && typeof parsed.owner_token === "string" && parsed.owner_token.length > 0
      ? parsed as LockMetadata
      : null;
  } catch {
    return null;
  }
}

async function processStartIdentity(pid: number, timeoutMs: number): Promise<string | null> {
  if (pid === process.pid) return SELF_PROCESS_START_IDENTITY;
  const command = process.platform === "win32" ? "powershell.exe" : "ps";
  const arguments_ = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`]
    : ["-o", "lstart=", "-p", String(pid)];
  return new Promise((resolvePromise) => {
    execFile(command, arguments_, { timeout: Math.max(1, timeoutMs), windowsHide: true }, (error, stdout) => {
      if (error || stdout.trim().length === 0) return resolvePromise(null);
      const parsed = Date.parse(stdout.trim());
      resolvePromise(Number.isFinite(parsed) ? `epoch-second:${Math.floor(parsed / 1_000)}` : null);
    });
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function recoverStaleLock(lockPath: string, identityBudgetMs: number): Promise<boolean> {
  let metadataText = "";
  let ageMs = 0;
  try {
    const metadata = await lstat(lockPath);
    if (metadata.isSymbolicLink()) throw new EventStoreError("PATH_ESCAPE");
    ageMs = Math.max(0, Date.now() - metadata.mtimeMs);
    metadataText = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const owner = parseLockMetadata(metadataText);
  let stale = owner ? !processIsAlive(owner.owner_pid) : ageMs >= STALE_INVALID_LOCK_MS;
  if (owner && !stale) {
    const currentIdentity = await processStartIdentity(owner.owner_pid, identityBudgetMs);
    stale = currentIdentity !== null && currentIdentity !== owner.owner_process_start_identity;
  }
  if (!stale) return false;
  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
    const movedOwner = parseLockMetadata(await readFile(stalePath, "utf8"));
    if (owner && movedOwner?.owner_token !== owner.owner_token) {
      await rename(stalePath, lockPath).catch(() => undefined);
      return false;
    }
    await unlink(stalePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

async function acquireMutationLock(
  root: string,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  syncMetadata = true,
): Promise<MutationLock> {
  const lockPath = join(root, ".events-mutation.lock");
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const owner = currentLockMetadata();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.write(`${canonicalJson(owner)}\n`);
        // Durable transactions sync ownership before proceeding. Best-effort
        // observers still await the complete metadata write, but deliberately
        // skip fsync so lock acquisition can honor its hard 5 ms budget.
        if (syncMetadata) await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      return {
        async release() {
          try {
            await handle.close();
          } finally {
            try {
              const current = parseLockMetadata(await readFile(lockPath, "utf8"));
              if (current?.owner_token === owner.owner_token) await unlink(lockPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await recoverStaleLock(lockPath, Math.min(25, Math.max(1, deadline - Date.now())))) continue;
      if (Date.now() >= deadline) throw new EventStoreError("LOCK_TIMEOUT");
      await sleep(Math.min(2, Math.max(0, deadline - Date.now())));
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertSafeReplacementTarget(root: string, name: typeof EVENT_STATE_REPLACEMENT_TARGETS[number]): Promise<void> {
  try {
    const metadata = await lstat(join(root, name));
    if (metadata.isSymbolicLink()) throw new EventStoreError("PATH_ESCAPE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function recoverEventStateReplacement(
  configuredRoot: string,
  options: { crashAfterSwaps?: number } = {},
): Promise<void> {
  const root = await resolveStateRoot(configuredRoot);
  const markerPath = await resolveContainedFile(root, "transactions", [], "active-replacement.json");
  let marker: ReplacementMarker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8")) as ReplacementMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (marker.schema_version !== 1
    || !/^[0-9a-f-]{36}$/.test(marker.transaction_id)
    || canonicalJson(marker.targets) !== canonicalJson(EVENT_STATE_REPLACEMENT_TARGETS)) {
    throw new EventStoreError("PATH_ESCAPE");
  }
  const transactionRoot = await resolveContainedDirectory(root, "transactions", marker.transaction_id);
  const nextRoot = await resolveContainedDirectory(transactionRoot, "transactions", "next");
  const backupRoot = await resolveContainedDirectory(transactionRoot, "transactions", "backup");
  let completedSwaps = 0;
  for (const target of EVENT_STATE_REPLACEMENT_TARGETS) {
    await assertSafeReplacementTarget(root, target);
    const live = join(root, target);
    const staged = join(nextRoot, target);
    const backup = join(backupRoot, target);
    if (await pathExists(staged)) {
      if (await pathExists(live)) {
        if (await pathExists(backup)) throw new EventStoreError("PARTITION_CORRUPT");
        await rename(live, backup);
      }
      await rename(staged, live);
      await syncDirectory(root);
      completedSwaps += 1;
      if (options.crashAfterSwaps === completedSwaps) {
        throw Object.assign(new Error("INJECTED_REPLACEMENT_CRASH"), { code: "INJECTED_REPLACEMENT_CRASH" });
      }
    } else if (!await pathExists(live)) {
      throw new EventStoreError("PARTITION_CORRUPT");
    }
  }
  await unlink(markerPath);
  await rm(transactionRoot, { recursive: true, force: true });
  await invalidateDerivedIndex(root, true);
  await syncDirectory(root);
}

function recordIdentity(recordType: DurableRecordType, value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const identity = (value as Record<string, unknown>)[ID_FIELDS[recordType]];
  return typeof identity === "string" && identity.length > 0 ? identity : null;
}

function recordTimestamp(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const timestamp = (value as Record<string, unknown>).timestamp;
  return typeof timestamp === "string" ? timestamp : null;
}

async function writeQuarantine(
  root: string,
  recordType: DurableRecordType,
  reason: QuarantineReason,
  content: string,
  stableSuffix?: string,
): Promise<string> {
  const quarantineDirectory = await resolveContainedDirectory(root, "quarantine");
  const suffix = stableSuffix ?? randomUUID();
  const fileName = `${recordType}-${reason.toLowerCase().replaceAll("_", "-")}-${suffix}.jsonl`;
  const path = join(quarantineDirectory, fileName);
  const envelope = canonicalJson({
    schema_version: 1,
    reason,
    record_type: recordType,
    content_digest: sha256Digest(content),
    content_bytes: Buffer.byteLength(content),
  });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.write(`${envelope}\n`);
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
  return fileName;
}

async function invalidateDerivedIndex(root: string, clearPending = false): Promise<void> {
  const indexRoot = join(root, ".events-index");
  try {
    const metadata = await lstat(indexRoot);
    if (metadata.isSymbolicLink()) throw new EventStoreError("PATH_ESCAPE");
    await rm(indexRoot, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (clearPending) await unlink(join(root, ".events-index-pending.json")).catch(() => undefined);
  await unlink(join(root, ".events-lifecycle-index.json")).catch(() => undefined);
  await syncDirectory(root);
}

async function parsePartitionUnlocked<T>(
  root: string,
  recordType: DurableRecordType,
  partitionPath: string,
): Promise<ParsedPartitionResult<T>> {
  let content: string;
  try {
    observeStoreIo("read", partitionPath);
    content = await readFile(partitionPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], quarantined: [], repaired: false };
    throw error;
  }

  const records: T[] = [];
  const quarantined: QuarantinedRecord[] = [];
  const identities = new Map<string, string>();
  const hasTail = content.length > 0 && !content.endsWith("\n");
  const lines = content.split("\n");
  if (!hasTail) lines.pop();
  const keptLines: string[] = [];
  let requiresRewrite = false;

  for (const [index, line] of lines.entries()) {
    const isTail = hasTail && index === lines.length - 1;
    if (isTail) {
      const fileName = await writeQuarantine(root, recordType, "MALFORMED_TAIL", line);
      quarantined.push({ reason: "MALFORMED_TAIL", line: index + 1, fileName });
      requiresRewrite = true;
      break;
    }

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      if (index !== lines.length - 1) throw new EventStoreError("PARTITION_CORRUPT");
      const fileName = await writeQuarantine(root, recordType, "MALFORMED_TAIL", `${line}\n`);
      quarantined.push({ reason: "MALFORMED_TAIL", line: index + 1, fileName });
      requiresRewrite = true;
      break;
    }

    const valueDigest = sha256Digest(value);
    if (!validateDurableRecordSchema(recordType, value).ok) {
      const fileName = await writeQuarantine(root, recordType, "SCHEMA_INVALID", `${line}\n`, valueDigest);
      quarantined.push({ reason: "SCHEMA_INVALID", line: index + 1, fileName });
      requiresRewrite = true;
      continue;
    }
    const identity = recordIdentity(recordType, value);
    if (identity === null) {
      const fileName = await writeQuarantine(root, recordType, "IDENTITY_COLLISION", `${line}\n`, valueDigest);
      quarantined.push({ reason: "IDENTITY_COLLISION", line: index + 1, fileName });
      requiresRewrite = true;
    } else {
      const previousDigest = identities.get(identity);
      if (previousDigest === undefined) {
        identities.set(identity, valueDigest);
        records.push(value as T);
        keptLines.push(canonicalJson(value));
      } else if (previousDigest !== valueDigest) {
        const fileName = await writeQuarantine(root, recordType, "IDENTITY_COLLISION", `${line}\n`, valueDigest);
        quarantined.push({ reason: "IDENTITY_COLLISION", line: index + 1, fileName });
        requiresRewrite = true;
      } else {
        requiresRewrite = true;
      }
    }
  }
  if (requiresRewrite) {
    const temporary = join(dirname(partitionPath), `.${recordType}-${randomUUID()}.rewrite`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      observeStoreIo("write", temporary);
      await handle.write(keptLines.length === 0 ? "" : `${keptLines.join("\n")}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, partitionPath);
    await syncDirectory(dirname(partitionPath));
    await invalidateDerivedIndex(root);
  }
  return { records, quarantined, repaired: requiresRewrite };
}

async function partitionDatesUnlocked(root: string, recordType: DurableRecordType): Promise<string[]> {
  const directory = await resolveContainedDirectory(root, recordType);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .map((entry) => entry.name.slice(0, 10))
    .sort();
}

async function loadRecordTypeUnlocked<T>(root: string, recordType: DurableRecordType): Promise<T[]> {
  const result: T[] = [];
  for (const date of await partitionDatesUnlocked(root, recordType)) {
    const path = await resolvePartitionPath(root, recordType, date);
    result.push(...(await parsePartitionUnlocked<T>(root, recordType, path)).records);
  }
  return result;
}

interface LifecycleRecords {
  events: SkillEvent[];
  scores: SkillScore[];
  candidates: EvalCandidate[];
  approvals: EvalCandidateApproval[];
}

interface IdentityShard {
  schema_version: 1;
  record_type: DurableRecordType;
  identity: string;
  digest: string;
}

interface InvocationShard {
  schema_version: 1;
  invocation_id: string;
  events: SkillEvent[];
  scores: SkillScore[];
}

interface CandidateShard {
  schema_version: 1;
  candidate_id: string;
  candidate: EvalCandidate | null;
  approvals: EvalCandidateApproval[];
}

interface PendingMutation {
  schema_version: 1;
  record_type: DurableRecordType;
  record: DurableRecord;
  digest: string;
  partition_date: string;
}

function lifecycleFromRecords(records: LifecycleRecords) {
  const index = createLifecycleIndex();
  const addExisting = (result: LifecycleMutationResult) => {
    if (!result.ok) throw new EventStoreError("PARTITION_CORRUPT");
  };
  for (const record of [...records.events].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) addExisting(index.addEvent(record));
  for (const record of [...records.scores].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) addExisting(index.addScore(record));
  for (const record of [...records.candidates].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) addExisting(index.addCandidate(record));
  for (const record of [...records.approvals].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) addExisting(index.addApproval(record));
  return index;
}

function containedSegments(root: string, candidate: string): string[] {
  const absolute = resolve(candidate);
  const fromRoot = relative(root, absolute);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    if (fromRoot === "") return [];
    throw new EventStoreError("PATH_ESCAPE");
  }
  return fromRoot.split(sep).filter(Boolean);
}

async function safeDirectory(root: string, path: string, create = true): Promise<string> {
  const segments = containedSegments(root, path);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return resolve(path);
      await mkdir(current, { mode: 0o700 });
      metadata = await lstat(current);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new EventStoreError("PATH_ESCAPE");
  }
  return resolve(path);
}

async function safeJsonFile(root: string, path: string): Promise<string> {
  containedSegments(root, path);
  await safeDirectory(root, dirname(path), false);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new EventStoreError("PATH_ESCAPE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolve(path);
}

async function readJson<T>(root: string, path: string): Promise<T | null> {
  await safeJsonFile(root, path);
  try {
    observeStoreIo("read", path);
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomicJson(root: string, path: string, value: unknown, sync: boolean): Promise<void> {
  await safeDirectory(root, dirname(path));
  await safeJsonFile(root, path);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    observeStoreIo("write", path);
    await handle.write(`${canonicalJson(value)}\n`);
    if (sync) await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  if (sync) await syncDirectory(dirname(path));
}

function identityPath(indexRoot: string, recordType: DurableRecordType, identity: string): string {
  return join(indexRoot, "identity", recordType, `${sha256Digest(identity)}.json`);
}

function invocationPath(indexRoot: string, invocationId: string): string {
  return join(indexRoot, "invocations", `${sha256Digest(invocationId)}.json`);
}

function candidatePath(indexRoot: string, candidateId: string): string {
  return join(indexRoot, "candidates", `${sha256Digest(candidateId)}.json`);
}

function recordId(recordType: DurableRecordType, record: DurableRecord): string {
  return (record as unknown as Record<string, string>)[ID_FIELDS[recordType]]!;
}

async function writeIdentity(root: string, indexRoot: string, recordType: DurableRecordType, record: DurableRecord, sync: boolean): Promise<void> {
  const identity = recordId(recordType, record);
  await writeAtomicJson(root, identityPath(indexRoot, recordType, identity), {
    schema_version: 1, record_type: recordType, identity, digest: sha256Digest(record),
  } satisfies IdentityShard, sync);
}

async function writeInvocation(root: string, indexRoot: string, shard: InvocationShard, sync: boolean): Promise<void> {
  await writeAtomicJson(root, invocationPath(indexRoot, shard.invocation_id), shard, sync);
}

async function writeCandidate(root: string, indexRoot: string, shard: CandidateShard, sync: boolean): Promise<void> {
  await writeAtomicJson(root, candidatePath(indexRoot, shard.candidate_id), shard, sync);
}

async function bootstrapIndex(root: string, sync: boolean): Promise<string> {
  const records: LifecycleRecords = {
    events: await loadRecordTypeUnlocked<SkillEvent>(root, "skill-events"),
    scores: await loadRecordTypeUnlocked<SkillScore>(root, "scores"),
    candidates: await loadRecordTypeUnlocked<EvalCandidate>(root, "eval-candidates"),
    approvals: await loadRecordTypeUnlocked<EvalCandidateApproval>(root, "candidate-approvals"),
  };
  lifecycleFromRecords(records);
  const staging = join(root, `.events-index-bootstrap-${randomUUID()}`);
  await safeDirectory(root, staging);
  for (const record of records.events) await writeIdentity(root, staging, "skill-events", record, sync);
  for (const record of records.scores) await writeIdentity(root, staging, "scores", record, sync);
  for (const record of records.candidates) await writeIdentity(root, staging, "eval-candidates", record, sync);
  for (const record of records.approvals) await writeIdentity(root, staging, "candidate-approvals", record, sync);

  const invocationIds = new Set([
    ...records.events.filter((record) => record.event_type !== "eligible").map((record) => record.invocation_id),
    ...records.scores.map((record) => record.invocation_id),
  ]);
  for (const invocationId of invocationIds) await writeInvocation(root, staging, {
    schema_version: 1,
    invocation_id: invocationId,
    events: records.events.filter((record) => record.event_type !== "eligible" && record.invocation_id === invocationId),
    scores: records.scores.filter((record) => record.invocation_id === invocationId),
  }, sync);
  const candidateIds = new Set([...records.candidates.map((record) => record.candidate_id), ...records.approvals.map((record) => record.candidate_id)]);
  for (const candidateId of candidateIds) await writeCandidate(root, staging, {
    schema_version: 1,
    candidate_id: candidateId,
    candidate: records.candidates.find((record) => record.candidate_id === candidateId) ?? null,
    approvals: records.approvals.filter((record) => record.candidate_id === candidateId),
  }, sync);
  await writeAtomicJson(root, join(staging, "meta.json"), { schema_version: 1, index_version: 2 }, sync);

  const target = join(root, ".events-index");
  const backup = join(root, `.events-index-backup-${randomUUID()}`);
  if (await pathExists(target)) {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new EventStoreError("PATH_ESCAPE");
    await rename(target, backup);
  }
  await rename(staging, target);
  if (sync) await syncDirectory(root);
  await rm(backup, { recursive: true, force: true });
  await unlink(join(root, ".events-lifecycle-index.json")).catch(() => undefined);
  return target;
}

async function ensureIndex(root: string, syncBootstrap: boolean): Promise<string> {
  const indexRoot = join(root, ".events-index");
  let meta: { schema_version?: number; index_version?: number } | null = null;
  try {
    meta = await readJson<{ schema_version?: number; index_version?: number }>(root, join(indexRoot, "meta.json"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return meta?.schema_version === 1 && meta.index_version === 2 ? indexRoot : bootstrapIndex(root, syncBootstrap);
}

async function readIdentity(root: string, indexRoot: string, recordType: DurableRecordType, identity: string): Promise<IdentityShard | null> {
  const shard = await readJson<IdentityShard>(root, identityPath(indexRoot, recordType, identity));
  if (shard === null) return null;
  if (shard.schema_version !== 1 || shard.record_type !== recordType || shard.identity !== identity || !/^[a-f0-9]{64}$/.test(shard.digest)) {
    throw new EventStoreError("PARTITION_CORRUPT");
  }
  return shard;
}

async function readInvocation(root: string, indexRoot: string, invocationId: string): Promise<InvocationShard> {
  const shard = await readJson<InvocationShard>(root, invocationPath(indexRoot, invocationId));
  if (shard === null) return { schema_version: 1, invocation_id: invocationId, events: [], scores: [] };
  if (shard.schema_version !== 1 || shard.invocation_id !== invocationId
    || !shard.events.every((record) => validateDurableRecordSchema("skill-events", record).ok)
    || !shard.scores.every((record) => validateDurableRecordSchema("scores", record).ok)) throw new EventStoreError("PARTITION_CORRUPT");
  return shard;
}

async function readCandidate(root: string, indexRoot: string, candidateId: string): Promise<CandidateShard> {
  const shard = await readJson<CandidateShard>(root, candidatePath(indexRoot, candidateId));
  if (shard === null) return { schema_version: 1, candidate_id: candidateId, candidate: null, approvals: [] };
  if (shard.schema_version !== 1 || shard.candidate_id !== candidateId
    || (shard.candidate !== null && !validateDurableRecordSchema("eval-candidates", shard.candidate).ok)
    || !shard.approvals.every((record) => validateDurableRecordSchema("candidate-approvals", record).ok)) throw new EventStoreError("PARTITION_CORRUPT");
  return shard;
}

async function applyRecordToIndex(root: string, indexRoot: string, recordType: DurableRecordType, record: DurableRecord, sync: boolean): Promise<void> {
  await writeIdentity(root, indexRoot, recordType, record, sync);
  if (recordType === "skill-events") {
    const event = record as SkillEvent;
    if (event.event_type === "eligible") return;
    const shard = await readInvocation(root, indexRoot, event.invocation_id);
    if (!shard.events.some((candidate) => candidate.event_id === event.event_id)) shard.events.push(event);
    await writeInvocation(root, indexRoot, shard, sync);
  } else if (recordType === "scores") {
    const score = record as SkillScore;
    const shard = await readInvocation(root, indexRoot, score.invocation_id);
    if (!shard.scores.some((candidate) => candidate.score_id === score.score_id)) shard.scores.push(score);
    await writeInvocation(root, indexRoot, shard, sync);
  } else if (recordType === "eval-candidates") {
    const candidate = record as EvalCandidate;
    const shard = await readCandidate(root, indexRoot, candidate.candidate_id);
    shard.candidate ??= candidate;
    await writeCandidate(root, indexRoot, shard, sync);
  } else {
    const approval = record as EvalCandidateApproval;
    const shard = await readCandidate(root, indexRoot, approval.candidate_id);
    if (!shard.approvals.some((candidate) => candidate.approval_id === approval.approval_id)) shard.approvals.push(approval);
    await writeCandidate(root, indexRoot, shard, sync);
  }
}

function lifecycleForInvocation(shard: InvocationShard) {
  return lifecycleFromRecords({ events: shard.events, scores: shard.scores, candidates: [], approvals: [] });
}

function lifecycleForCandidate(shard: CandidateShard) {
  return lifecycleFromRecords({ events: [], scores: [], candidates: shard.candidate ? [shard.candidate] : [], approvals: shard.approvals });
}

async function writePending(root: string, pending: PendingMutation, sync: boolean): Promise<void> {
  await writeAtomicJson(root, join(root, ".events-index-pending.json"), pending, sync);
}

async function clearPending(root: string, sync: boolean): Promise<void> {
  await unlink(join(root, ".events-index-pending.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (sync) await syncDirectory(root);
}

async function recoverPendingMutation(root: string): Promise<void> {
  const pending = await readJson<PendingMutation>(root, join(root, ".events-index-pending.json"));
  if (pending === null) return;
  if (pending.schema_version !== 1 || !validateDurableRecordSchema(pending.record_type, pending.record).ok
    || pending.digest !== sha256Digest(pending.record) || recordTimestamp(pending.record)?.slice(0, 10) !== pending.partition_date) {
    throw new EventStoreError("PARTITION_CORRUPT");
  }
  let indexRoot = await ensureIndex(root, true);
  const partitionPath = await resolvePartitionPath(root, pending.record_type, pending.partition_date);
  const parsed = await parsePartitionUnlocked<DurableRecord>(root, pending.record_type, partitionPath);
  if (parsed.repaired) indexRoot = await ensureIndex(root, true);
  const persisted = parsed.records.find((record) => recordId(pending.record_type, record) === recordId(pending.record_type, pending.record));
  if (persisted && sha256Digest(persisted) === pending.digest) {
    try {
      await applyRecordToIndex(root, indexRoot, pending.record_type, pending.record, true);
    } catch (error) {
      if (!isDerivedIndexCorruption(error)) throw error;
      await invalidateDerivedIndex(root);
      await bootstrapIndex(root, true);
    }
  }
  await clearPending(root, true);
}

function validateLifecycle(index: ReturnType<typeof createLifecycleIndex>, recordType: DurableRecordType, record: DurableRecord): LifecycleMutationResult {
  if (recordType === "skill-events") return index.addEvent(record as SkillEvent);
  if (recordType === "scores") return index.addScore(record as SkillScore);
  if (recordType === "eval-candidates") return index.addCandidate(record as EvalCandidate);
  return index.addApproval(record as EvalCandidateApproval);
}

function shouldQuarantine(recordType: DurableRecordType, reason: LifecycleReason): boolean {
  if (reason.endsWith("_ID_COLLISION")) return true;
  if (recordType === "candidate-approvals") return true;
  return recordType === "scores" && reason !== "UNKNOWN_SCORE_INVOCATION" && reason !== "SCORE_TIMESTAMP_PRECEDES_INVOCATION";
}

function isDerivedIndexCorruption(error: unknown): boolean {
  return error instanceof SyntaxError
    || (error instanceof EventStoreError && error.code === "PARTITION_CORRUPT");
}

interface IndexedMutationInspection {
  indexRoot: string;
  existingIdentity: IdentityShard | null;
  lifecycleResult: LifecycleMutationResult | null;
}

async function inspectIndexedMutation(
  root: string,
  indexRoot: string,
  recordType: DurableRecordType,
  record: DurableRecord,
  identity: string,
): Promise<IndexedMutationInspection> {
  const existingIdentity = await readIdentity(root, indexRoot, recordType, identity);
  if (existingIdentity !== null) return { indexRoot, existingIdentity, lifecycleResult: null };
  let lifecycle: ReturnType<typeof createLifecycleIndex>;
  if (recordType === "skill-events") {
    const event = record as SkillEvent;
    lifecycle = event.event_type === "eligible"
      ? createLifecycleIndex()
      : lifecycleForInvocation(await readInvocation(root, indexRoot, event.invocation_id));
  } else if (recordType === "scores") {
    lifecycle = lifecycleForInvocation(await readInvocation(root, indexRoot, (record as SkillScore).invocation_id));
  } else if (recordType === "eval-candidates") {
    lifecycle = lifecycleForCandidate(await readCandidate(root, indexRoot, (record as EvalCandidate).candidate_id));
  } else {
    lifecycle = lifecycleForCandidate(await readCandidate(root, indexRoot, (record as EvalCandidateApproval).candidate_id));
  }
  return { indexRoot, existingIdentity, lifecycleResult: validateLifecycle(lifecycle, recordType, record) };
}

async function inspectIndexedMutationWithRecovery(
  root: string,
  recordType: DurableRecordType,
  record: DurableRecord,
  identity: string,
  sync: boolean,
): Promise<IndexedMutationInspection> {
  let indexRoot = await ensureIndex(root, sync);
  try {
    return await inspectIndexedMutation(root, indexRoot, recordType, record, identity);
  } catch (error) {
    if (!isDerivedIndexCorruption(error)) throw error;
    await invalidateDerivedIndex(root);
    indexRoot = await bootstrapIndex(root, sync);
    return inspectIndexedMutation(root, indexRoot, recordType, record, identity);
  }
}

async function mutateUnlocked(
  root: string,
  recordType: DurableRecordType,
  record: DurableRecord,
  sync: boolean,
): Promise<AppendResult> {
  const timestamp = recordTimestamp(record);
  const identity = recordIdentity(recordType, record);
  if (timestamp === null || identity === null || !validateDurableRecordSchema(recordType, record).ok) {
    throw new EventStoreError("RECORD_INVALID");
  }
  const partitionPath = await resolvePartitionPath(root, recordType, timestamp);
  const digest = sha256Digest(record);
  const inspection = await inspectIndexedMutationWithRecovery(root, recordType, record, identity, sync);
  const { existingIdentity, indexRoot, lifecycleResult } = inspection;
  if (existingIdentity?.digest === digest) return { status: "duplicate", digest, partitionPath, reason: null };
  if (existingIdentity !== null) {
    await writeQuarantine(root, recordType, "IDENTITY_COLLISION", `${canonicalJson(record)}\n`, digest);
    return { status: "quarantined", digest, partitionPath, reason: "IDENTITY_COLLISION" };
  }
  if (lifecycleResult === null) throw new EventStoreError("PARTITION_CORRUPT");
  if (!lifecycleResult.ok) {
    if (shouldQuarantine(recordType, lifecycleResult.reason)) {
      const reason = lifecycleResult.reason.endsWith("_ID_COLLISION") ? "IDENTITY_COLLISION" : lifecycleResult.reason;
      await writeQuarantine(root, recordType, reason, `${canonicalJson(record)}\n`, digest);
      return { status: "quarantined", digest, partitionPath, reason };
    }
    return { status: "rejected", digest, partitionPath, reason: lifecycleResult.reason };
  }
  if (lifecycleResult.status === "duplicate") return { status: "duplicate", digest, partitionPath, reason: null };

  await writePending(root, {
    schema_version: 1,
    record_type: recordType,
    record,
    digest,
    partition_date: timestamp.slice(0, 10),
  }, sync);
  const handle = await open(partitionPath, "a", 0o600);
  try {
    observeStoreIo("write", partitionPath);
    await handle.write(`${canonicalJson(record)}\n`);
    if (sync) await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await applyRecordToIndex(root, indexRoot, recordType, record, sync);
  } catch (error) {
    if (!isDerivedIndexCorruption(error)) throw error;
    await invalidateDerivedIndex(root);
    await bootstrapIndex(root, sync);
  }
  await clearPending(root, sync);
  return { status: "appended", digest, partitionPath, reason: null };
}

export async function withEventStateTransaction<T>(
  configuredRoot: string,
  operation: (transaction: EventStateTransaction) => Promise<T>,
  options: MutationOptions = {},
): Promise<T> {
  const root = await resolveStateRoot(configuredRoot);
  const lock = await acquireMutationLock(root, options.lockTimeoutMs);
  const transaction: EventStateTransaction = Object.freeze({
    root,
    async readPartition<R>(recordType: DurableRecordType, date: string) {
      const partitionPath = await resolvePartitionPath(root, recordType, date);
      const parsed = await parsePartitionUnlocked<R>(root, recordType, partitionPath);
      if (parsed.repaired) await ensureIndex(root, true);
      return { records: parsed.records, quarantined: parsed.quarantined };
    },
    async mutate(recordType: DurableRecordType, record: DurableRecord, mutationOptions: { sync?: boolean } = {}) {
      return mutateUnlocked(root, recordType, record, mutationOptions.sync !== false);
    },
  });
  try {
    await recoverEventStateReplacement(root);
    await recoverPendingMutation(root);
    return await operation(transaction);
  } finally {
    await lock.release();
  }
}

export async function mutateDurableRecord(
  configuredRoot: string,
  recordType: DurableRecordType,
  record: DurableRecord,
  options: MutationOptions = {},
): Promise<AppendResult> {
  return withEventStateTransaction(configuredRoot, (transaction) => transaction.mutate(recordType, record), options);
}

/** @deprecated Use mutateDurableRecord. This compatibility name now uses the same safe transaction. */
export async function appendDurable(
  configuredRoot: string,
  recordType: DurableRecordType,
  record: DurableRecord,
): Promise<AppendResult> {
  return mutateDurableRecord(configuredRoot, recordType, record);
}

export async function readPartition<T>(
  configuredRoot: string,
  recordType: DurableRecordType,
  date: string,
): Promise<ReadPartitionResult<T>> {
  return withEventStateTransaction(configuredRoot, (transaction) => transaction.readPartition<T>(recordType, date));
}

export async function createLocalBestEffortDependencies(configuredRoot: string): Promise<BestEffortDependencies> {
  const root = await resolveStateRoot(configuredRoot);
  return {
    now: () => Date.now(),
    delay: sleep,
    async acquireLock(lockBudgetMs) {
      try {
        return await acquireMutationLock(root, lockBudgetMs, false);
      } catch (error) {
        if ((error as { code?: string }).code === "LOCK_TIMEOUT") return null;
        throw error;
      }
    },
    async appendUnlocked(record) {
      const result = await mutateUnlocked(root, "skill-events", record, false);
      if (result.status !== "appended" && result.status !== "duplicate") {
        throw new EventStoreError("RECORD_INVALID");
      }
    },
  };
}

const DEFAULT_BEST_EFFORT_POLICY = Object.freeze({ lockBudgetMs: 5, totalBudgetMs: 20 });

export async function appendBestEffort(
  dependencies: BestEffortDependencies,
  record: SkillEvent,
  policy: BestEffortPolicy = DEFAULT_BEST_EFFORT_POLICY,
): Promise<BestEffortResult> {
  if (!validateDurableRecordSchema("skill-events", record).ok) {
    return { recorded: false, reason: "VALIDATION_FAILED" };
  }
  const startedAt = dependencies.now();
  const acquisition = dependencies.acquireLock(policy.lockBudgetMs);
  const lockTimeout = dependencies.delay(policy.lockBudgetMs).then(() => Symbol.for("lock-timeout"));
  let acquired: BestEffortLock | null | symbol;
  try {
    acquired = await Promise.race([acquisition, lockTimeout]);
  } catch {
    return { recorded: false, reason: "IO_ERROR" };
  }
  if (typeof acquired === "symbol" || acquired === null) {
    void acquisition.then(async (lateLock) => {
      if (lateLock) await lateLock.release();
    }).catch(() => undefined);
    return { recorded: false, reason: "LOCK_TIMEOUT" };
  }

  const worker: Promise<BestEffortResult> = (async () => {
    try {
      await dependencies.appendUnlocked(record);
      return { recorded: true, reason: null };
    } catch {
      return { recorded: false, reason: "IO_ERROR" };
    } finally {
      try {
        await acquired.release();
      } catch {
        // Recording is observational; release failures stay bounded to this result.
      }
    }
  })();
  const elapsed = Math.max(0, dependencies.now() - startedAt);
  const remaining = Math.max(0, policy.totalBudgetMs - elapsed);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const deadline = dependencies.delay(remaining).then((): BestEffortResult => ({ recorded: false, reason: "DEADLINE_EXCEEDED" }));
  return Promise.race([worker, deadline]);
}

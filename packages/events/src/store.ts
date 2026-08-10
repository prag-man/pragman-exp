import { randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256Digest } from "./canonical.ts";
import {
  EventStoreError,
  resolveContainedDirectory,
  resolvePartitionPath,
  resolveStateRoot,
  type DurableRecordType,
} from "./paths.ts";
import type { EvalCandidate, EvalCandidateApproval, SkillEvent, SkillScore } from "./types.ts";
import { validateDurableRecordSchema } from "./validation.ts";

export type DurableRecord = SkillEvent | SkillScore | EvalCandidate | EvalCandidateApproval;
export type QuarantineReason = "IDENTITY_COLLISION" | "MALFORMED_TAIL";

export type AppendResult =
  | { status: "appended" | "duplicate"; digest: string; partitionPath: string; reason: null }
  | { status: "quarantined"; digest: string; partitionPath: string; reason: "IDENTITY_COLLISION" };

export interface QuarantinedRecord {
  reason: QuarantineReason;
  line: number;
  fileName: string;
}

export interface ReadPartitionResult<T> {
  records: T[];
  quarantined: QuarantinedRecord[];
}

interface MutationLock {
  release(): Promise<void>;
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

const ID_FIELDS: Record<DurableRecordType, string> = {
  "skill-events": "event_id",
  scores: "score_id",
  "eval-candidates": "candidate_id",
  "candidate-approvals": "approval_id",
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function acquireMutationLock(root: string): Promise<MutationLock> {
  const lockPath = join(root, ".events-mutation.lock");
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      return {
        async release() {
          try {
            await handle.close();
          } finally {
            try {
              await unlink(lockPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockMetadata = await lstat(lockPath);
        if (lockMetadata.isSymbolicLink()) throw new EventStoreError("PATH_ESCAPE");
      } catch (metadataError) {
        if ((metadataError as NodeJS.ErrnoException).code !== "ENOENT") throw metadataError;
      }
      await sleep(2);
    }
  }
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
  const fileName = `${recordType}-${reason.toLowerCase()}-${suffix}.jsonl`;
  const path = join(quarantineDirectory, fileName);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.write(content);
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
  return fileName;
}

async function parsePartitionUnlocked<T>(
  root: string,
  recordType: DurableRecordType,
  partitionPath: string,
): Promise<ReadPartitionResult<T>> {
  let content: string;
  try {
    content = await readFile(partitionPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], quarantined: [] };
    throw error;
  }

  const records: T[] = [];
  const quarantined: QuarantinedRecord[] = [];
  const identities = new Map<string, string>();
  const hasTail = content.length > 0 && !content.endsWith("\n");
  const lines = content.split("\n");
  if (!hasTail) lines.pop();
  let validPrefixLength = 0;

  for (const [index, line] of lines.entries()) {
    const isTail = hasTail && index === lines.length - 1;
    if (isTail) {
      const fileName = await writeQuarantine(root, recordType, "MALFORMED_TAIL", line);
      quarantined.push({ reason: "MALFORMED_TAIL", line: index + 1, fileName });
      const handle = await open(partitionPath, "r+");
      try {
        await handle.truncate(validPrefixLength);
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    }

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      if (index !== lines.length - 1) throw new EventStoreError("PARTITION_CORRUPT");
      const fileName = await writeQuarantine(root, recordType, "MALFORMED_TAIL", `${line}\n`);
      quarantined.push({ reason: "MALFORMED_TAIL", line: index + 1, fileName });
      const handle = await open(partitionPath, "r+");
      try {
        await handle.truncate(validPrefixLength);
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    }

    const identity = recordIdentity(recordType, value);
    const valueDigest = sha256Digest(value);
    if (identity === null) {
      const fileName = await writeQuarantine(root, recordType, "IDENTITY_COLLISION", `${line}\n`, valueDigest);
      quarantined.push({ reason: "IDENTITY_COLLISION", line: index + 1, fileName });
    } else {
      const previousDigest = identities.get(identity);
      if (previousDigest === undefined) {
        identities.set(identity, valueDigest);
        records.push(value as T);
      } else if (previousDigest !== valueDigest) {
        const fileName = await writeQuarantine(root, recordType, "IDENTITY_COLLISION", `${line}\n`, valueDigest);
        quarantined.push({ reason: "IDENTITY_COLLISION", line: index + 1, fileName });
      }
    }
    validPrefixLength += Buffer.byteLength(`${line}\n`);
  }
  return { records, quarantined };
}

async function findIdentityDigest(
  root: string,
  recordType: DurableRecordType,
  identity: string,
): Promise<string | null> {
  const directory = join(root, recordType);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const content = await readFile(join(directory, entry.name), "utf8");
    for (const line of content.split("\n")) {
      if (line.length === 0) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (recordIdentity(recordType, value) === identity) return sha256Digest(value);
      } catch {
        break;
      }
    }
  }
  return null;
}

export async function appendDurable(
  configuredRoot: string,
  recordType: DurableRecordType,
  record: DurableRecord,
): Promise<AppendResult> {
  const root = await resolveStateRoot(configuredRoot);
  const timestamp = recordTimestamp(record);
  const identity = recordIdentity(recordType, record);
  if (timestamp === null || identity === null || !validateDurableRecordSchema(recordType, record).ok) {
    throw new EventStoreError("RECORD_INVALID");
  }
  const partitionPath = await resolvePartitionPath(root, recordType, timestamp);
  const digest = sha256Digest(record);
  const lock = await acquireMutationLock(root);
  try {
    await parsePartitionUnlocked(root, recordType, partitionPath);
    const existingDigest = await findIdentityDigest(root, recordType, identity);
    if (existingDigest === digest) return { status: "duplicate", digest, partitionPath, reason: null };
    if (existingDigest !== null) {
      await writeQuarantine(root, recordType, "IDENTITY_COLLISION", `${canonicalJson(record)}\n`, digest);
      return { status: "quarantined", digest, partitionPath, reason: "IDENTITY_COLLISION" };
    }

    const handle = await open(partitionPath, "a", 0o600);
    try {
      await handle.write(`${canonicalJson(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { status: "appended", digest, partitionPath, reason: null };
  } finally {
    await lock.release();
  }
}

export async function readPartition<T>(
  configuredRoot: string,
  recordType: DurableRecordType,
  date: string,
): Promise<ReadPartitionResult<T>> {
  const root = await resolveStateRoot(configuredRoot);
  const partitionPath = await resolvePartitionPath(root, recordType, date);
  const lock = await acquireMutationLock(root);
  try {
    return await parsePartitionUnlocked<T>(root, recordType, partitionPath);
  } finally {
    await lock.release();
  }
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

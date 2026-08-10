import { lstat, mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";

export const DURABLE_RECORD_TYPES = [
  "skill-events",
  "scores",
  "eval-candidates",
  "candidate-approvals",
] as const;

export type DurableRecordType = typeof DURABLE_RECORD_TYPES[number];
export type EventStoreErrorCode =
  | "INVALID_PARTITION_DATE"
  | "INVALID_RECORD_TYPE"
  | "LOCK_TIMEOUT"
  | "PARTITION_CORRUPT"
  | "PATH_ESCAPE"
  | "RECORD_INVALID"
  | "UNSAFE_STATE_ROOT";

export class EventStoreError extends Error {
  readonly code: EventStoreErrorCode;

  constructor(code: EventStoreErrorCode) {
    super(code);
    this.name = "EventStoreError";
    this.code = code;
  }
}

const STATE_ROOT_MARKER = ".pragman-events-state.json";
const STATE_ROOT_MARKER_VALUE = Object.freeze({
  schema_version: 1,
  owner: "@prag-man/pragman-exp",
  purpose: "event-state-root",
});
const STATE_ROOT_MARKER_BYTES = `${JSON.stringify(STATE_ROOT_MARKER_VALUE)}\n`;
const LEGACY_TOP_LEVEL_NAMES = new Set([
  ...DURABLE_RECORD_TYPES,
  "quarantine",
  "plans",
  "rollups",
  "transactions",
  "eval-evidence",
  ".events-index",
  ".events-index-pending.json",
  ".events-lifecycle-index.json",
  ".events-mutation.lock",
]);
const DATE_PARTITION = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DATE_ROLLUP = /^\d{4}-\d{2}-\d{2}\.json$/;
const VERIFIED_STATE_ROOTS = new Set<string>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function canonicalKnownPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch { return resolve(path); }
}

async function isBroadStateRoot(root: string): Promise<boolean> {
  if (root === parse(root).root) return true;
  const broadRoots = await Promise.all([
    homedir(),
    dirname(homedir()),
    tmpdir(),
    process.cwd(),
  ].map(canonicalKnownPath));
  if (broadRoots.includes(root)) return true;
  try {
    const [rootMetadata, parentMetadata] = await Promise.all([stat(root), stat(dirname(root))]);
    if (rootMetadata.dev !== parentMetadata.dev) return true;
  } catch {
    // The root itself is known to exist here. A parent stat failure is not a
    // reason to weaken the ownership checks below.
  }
  return false;
}

async function validateOwnershipMarker(root: string): Promise<boolean> {
  const markerPath = resolve(root, STATE_ROOT_MARKER);
  let metadata;
  try { metadata = await lstat(markerPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new EventStoreError("PATH_ESCAPE");
  if (!metadata.isFile() || metadata.size > 512) throw new EventStoreError("UNSAFE_STATE_ROOT");
  try {
    const value = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
    const keys = isPlainObject(value) ? Object.keys(value).sort() : [];
    if (!isPlainObject(value)
      || keys.join(",") !== "owner,purpose,schema_version"
      || value.schema_version !== STATE_ROOT_MARKER_VALUE.schema_version
      || value.owner !== STATE_ROOT_MARKER_VALUE.owner
      || value.purpose !== STATE_ROOT_MARKER_VALUE.purpose) {
      throw new EventStoreError("UNSAFE_STATE_ROOT");
    }
  } catch (error) {
    if (error instanceof EventStoreError) throw error;
    throw new EventStoreError("UNSAFE_STATE_ROOT");
  }
  return true;
}

async function readSafeEntries(path: string) {
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.length > 20_000) throw new EventStoreError("UNSAFE_STATE_ROOT");
  for (const entry of entries) if (entry.isSymbolicLink()) throw new EventStoreError("PATH_ESCAPE");
  return entries;
}

async function legacyDurableDirectory(root: string, name: DurableRecordType): Promise<{ valid: boolean; evidence: boolean }> {
  const directory = resolve(root, name);
  const entries = await readSafeEntries(directory);
  let evidence = false;
  const identityKey: Record<DurableRecordType, string> = {
    "skill-events": "event_id",
    scores: "score_id",
    "eval-candidates": "candidate_id",
    "candidate-approvals": "approval_id",
  };
  for (const entry of entries) {
    if (!entry.isFile() || !DATE_PARTITION.test(entry.name)) return { valid: false, evidence: false };
    let firstLine = "";
    try { firstLine = (await readFile(resolve(directory, entry.name), "utf8")).split("\n", 1)[0] ?? ""; }
    catch { return { valid: false, evidence: false }; }
    if (firstLine.length === 0) continue;
    try {
      const value = JSON.parse(firstLine) as unknown;
      if (!isPlainObject(value) || value.schema_version !== 1
        || typeof value.timestamp !== "string" || typeof value[identityKey[name]] !== "string") {
        return { valid: false, evidence: false };
      }
      evidence = true;
    } catch { return { valid: false, evidence: false }; }
  }
  return { valid: true, evidence };
}

async function legacyRollupDirectory(root: string): Promise<{ valid: boolean; evidence: boolean }> {
  const rollups = resolve(root, "rollups");
  const periods = await readSafeEntries(rollups);
  let evidence = false;
  for (const period of periods) {
    if (!period.isDirectory() || (period.name !== "daily" && period.name !== "weekly")) return { valid: false, evidence: false };
    const directory = resolve(rollups, period.name);
    for (const entry of await readSafeEntries(directory)) {
      if (!entry.isFile() || !DATE_ROLLUP.test(entry.name)) return { valid: false, evidence: false };
      try {
        const parsed = JSON.parse(await readFile(resolve(directory, entry.name), "utf8")) as unknown;
        const records = Array.isArray(parsed) ? parsed : [parsed];
        if (records.length === 0 || records.some((value) => !isPlainObject(value)
          || value.schema_version !== 1 || typeof value.rollup_id !== "string"
          || typeof value.period_start !== "string")) return { valid: false, evidence: false };
        evidence = true;
      } catch { return { valid: false, evidence: false }; }
    }
  }
  return { valid: true, evidence };
}

async function legacyQuarantineDirectory(root: string): Promise<boolean> {
  const directory = resolve(root, "quarantine");
  for (const entry of await readSafeEntries(directory)) {
    if (!entry.isFile()) return false;
    try {
      const metadata = await lstat(resolve(directory, entry.name));
      if (metadata.size > 4_096) return false;
      const value = JSON.parse(await readFile(resolve(directory, entry.name), "utf8")) as unknown;
      if (!isPlainObject(value) || value.schema_version !== 1
        || typeof value.reason !== "string"
        || !(DURABLE_RECORD_TYPES as readonly unknown[]).includes(value.record_type)
        || typeof value.content_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.content_digest)
        || !Number.isSafeInteger(value.content_bytes) || (value.content_bytes as number) < 0) return false;
    } catch { return false; }
  }
  return true;
}

async function isRecognizableLegacyStateRoot(root: string, names: readonly string[]): Promise<boolean> {
  if (names.length === 0 || names.some((name) => !LEGACY_TOP_LEVEL_NAMES.has(name)
    && !/^\.events-index-(?:bootstrap|backup)-[0-9a-f-]{36}$/.test(name)
    && !/^\.events-mutation\.lock\.stale-[0-9a-f-]{36}$/.test(name))) return false;

  let evidence = false;
  let durableDirectoryCount = 0;
  let hasRollups = false;
  let hasQuarantine = false;
  for (const name of names) {
    const metadata = await lstat(resolve(root, name));
    if (metadata.isSymbolicLink()) throw new EventStoreError("PATH_ESCAPE");
    if ((DURABLE_RECORD_TYPES as readonly string[]).includes(name)) {
      if (!metadata.isDirectory()) return false;
      durableDirectoryCount += 1;
      const result = await legacyDurableDirectory(root, name as DurableRecordType);
      if (!result.valid) return false;
      evidence ||= result.evidence;
    } else if (name === "rollups") {
      if (!metadata.isDirectory()) return false;
      hasRollups = true;
      const result = await legacyRollupDirectory(root);
      if (!result.valid) return false;
      evidence ||= result.evidence;
    } else if (name === "quarantine") {
      if (!metadata.isDirectory() || !await legacyQuarantineDirectory(root)) return false;
      hasQuarantine = true;
    } else if (["plans", "transactions", "eval-evidence", ".events-index"].includes(name)
      || name.startsWith(".events-index-bootstrap-") || name.startsWith(".events-index-backup-")) {
      if (!metadata.isDirectory()) return false;
    } else if (!metadata.isFile()) return false;
  }
  return evidence || (durableDirectoryCount === DURABLE_RECORD_TYPES.length && hasRollups && hasQuarantine);
}

async function writeOwnershipMarker(root: string): Promise<void> {
  const markerPath = resolve(root, STATE_ROOT_MARKER);
  let handle;
  try {
    handle = await open(markerPath, "wx", 0o600);
    await handle.write(STATE_ROOT_MARKER_BYTES);
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
  if (!await validateOwnershipMarker(root)) throw new EventStoreError("UNSAFE_STATE_ROOT");
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

async function existingRealPath(path: string): Promise<string | null> {
  try {
    await lstat(path);
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function partitionDate(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/.exec(value);
  const parsedDate = match ? new Date(`${match[1]}T00:00:00Z`) : null;
  if (!match || parsedDate === null || !Number.isFinite(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== match[1]) {
    throw new EventStoreError("INVALID_PARTITION_DATE");
  }
  return match[1]!;
}

export async function resolveStateRoot(configuredRoot: string): Promise<string> {
  const absoluteRoot = resolve(configuredRoot);
  if (absoluteRoot === "/") throw new EventStoreError("UNSAFE_STATE_ROOT");
  await mkdir(absoluteRoot, { recursive: true });
  const resolvedRoot = await realpath(absoluteRoot);
  // Ownership is process-stable once this process has validated or created the
  // marker. Contained target checks still run for every file operation; this
  // avoids repeatedly reading the marker inside the hard-deadline observer.
  if (VERIFIED_STATE_ROOTS.has(resolvedRoot)) return resolvedRoot;
  if (await isBroadStateRoot(resolvedRoot)) throw new EventStoreError("UNSAFE_STATE_ROOT");
  if (await validateOwnershipMarker(resolvedRoot)) {
    VERIFIED_STATE_ROOTS.add(resolvedRoot);
    return resolvedRoot;
  }
  const entries = await readSafeEntries(resolvedRoot);
  const names = entries.map((entry) => entry.name);
  // Another local writer may have claimed the same empty root between the
  // marker check and directory read. Validate its completed claim instead of
  // treating that normal initialization race as foreign state.
  if (names.includes(STATE_ROOT_MARKER)) {
    if (await validateOwnershipMarker(resolvedRoot)) {
      VERIFIED_STATE_ROOTS.add(resolvedRoot);
      return resolvedRoot;
    }
    throw new EventStoreError("UNSAFE_STATE_ROOT");
  }
  if (names.length > 0 && !await isRecognizableLegacyStateRoot(resolvedRoot, names)) {
    throw new EventStoreError("UNSAFE_STATE_ROOT");
  }
  await writeOwnershipMarker(resolvedRoot);
  VERIFIED_STATE_ROOTS.add(resolvedRoot);
  return resolvedRoot;
}

export async function resolveContainedDirectory(
  configuredRoot: string,
  directoryName: DurableRecordType | "quarantine" | "plans" | "rollups" | "transactions",
  ...children: string[]
): Promise<string> {
  if (directoryName !== "quarantine"
    && directoryName !== "plans"
    && directoryName !== "rollups"
    && directoryName !== "transactions"
    && !(DURABLE_RECORD_TYPES as readonly unknown[]).includes(directoryName)) {
    throw new EventStoreError("INVALID_RECORD_TYPE");
  }
  if (children.some((child) => !/^[A-Za-z0-9._-]+$/.test(child) || child === "." || child === "..")) {
    throw new EventStoreError("PATH_ESCAPE");
  }
  const root = await resolveStateRoot(configuredRoot);
  const directory = resolve(root, directoryName, ...children);
  if (!isContained(root, directory)) throw new EventStoreError("PATH_ESCAPE");
  const existingDirectory = await existingRealPath(directory);
  if (existingDirectory !== null && !isContained(root, existingDirectory)) {
    throw new EventStoreError("PATH_ESCAPE");
  }
  await mkdir(directory, { recursive: true });
  const resolvedDirectory = await realpath(directory);
  if (!isContained(root, resolvedDirectory)) throw new EventStoreError("PATH_ESCAPE");
  return resolvedDirectory;
}

export async function resolveContainedFile(
  configuredRoot: string,
  directoryName: "plans" | "rollups" | "transactions",
  childDirectories: readonly string[],
  fileName: string,
): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName) || fileName === "." || fileName === "..") {
    throw new EventStoreError("PATH_ESCAPE");
  }
  const root = await resolveStateRoot(configuredRoot);
  const directory = await resolveContainedDirectory(root, directoryName, ...childDirectories);
  const candidate = resolve(directory, fileName);
  if (!isContained(root, candidate)) throw new EventStoreError("PATH_ESCAPE");
  const existing = await existingRealPath(candidate);
  if (existing !== null && !isContained(root, existing)) throw new EventStoreError("PATH_ESCAPE");
  return existing ?? candidate;
}

export async function resolvePartitionPath(
  configuredRoot: string,
  recordType: DurableRecordType,
  timestampOrDate: string,
): Promise<string> {
  const root = await resolveStateRoot(configuredRoot);
  const resolvedDirectory = await resolveContainedDirectory(root, recordType);

  const partition = resolve(resolvedDirectory, `${partitionDate(timestampOrDate)}.jsonl`);
  if (!isContained(root, partition)) throw new EventStoreError("PATH_ESCAPE");
  const existingPartition = await existingRealPath(partition);
  if (existingPartition !== null && !isContained(root, existingPartition)) {
    throw new EventStoreError("PATH_ESCAPE");
  }
  return existingPartition ?? partition;
}

import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

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
  if (resolvedRoot === "/") throw new EventStoreError("UNSAFE_STATE_ROOT");
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

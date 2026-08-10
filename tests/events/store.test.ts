import assert from "node:assert/strict";
import { open, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";

import {
  appendDurable,
  canonicalJson,
  readPartition,
  resolvePartitionPath,
  resolveStateRoot,
  sha256Digest,
  type DurableRecord,
  type DurableRecordType,
  type EvalCandidate,
  type EvalCandidateApproval,
  type SkillEvent,
  type SkillScore,
} from "../../packages/events/src/index.ts";
import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";

const digest = (character: string) => character.repeat(64);
const temporaryRoots: string[] = [];
let root = "";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

beforeEach(async () => {
  root = await temporaryDirectory("pragman-events-store-");
});

after(async () => {
  await Promise.all(temporaryRoots.map((directory) => rm(directory, { recursive: true, force: true })));
});

function event(overrides: Partial<SkillEvent> = {}): SkillEvent {
  return {
    schema_version: 1,
    event_id: "018f5b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    invocation_id: "01905b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:00:00Z",
    event_type: "invoked",
    skill_id: "pragman:review",
    skill_version: "1.2.3",
    skill_digest: digest("a"),
    skill_type: "capability",
    host: "codex",
    host_version: "1.2.0",
    model: "gpt-5",
    model_version: "2026-08-01",
    harness_version: "1.0.0",
    invocation_mode: "host",
    session_id: null,
    route_id: null,
    eval_id: null,
    case_id: null,
    trial_id: null,
    provider: "pragman:builtin-review",
    ablation_arm: "production",
    trigger_expected: null,
    trigger_actual: true,
    provider_digest: digest("b"),
    eval_corpus_digest: null,
    trial_policy_digest: null,
    status: null,
    outcome_code: null,
    duration_ms: 0,
    tool_calls: 0,
    retries: 0,
    rework_cycles: 0,
    verification_checks: 0,
    verification_passes: 0,
    observation_source: "host-adapter",
    source_aliases: ["host-observation"],
    storage_scope: "local",
    append_only: true,
    ...overrides,
  };
}

function score(overrides: Partial<SkillScore> = {}): SkillScore {
  return {
    schema_version: 1,
    score_id: "01915b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:05:00Z",
    invocation_id: event().invocation_id,
    metric_id: "task-success",
    metric_definition_digest: digest("c"),
    value: true,
    value_type: "boolean",
    source: "deterministic",
    grader_id: "task-success-grader",
    grader_version: "1.0.0",
    rubric_digest: digest("c"),
    evidence_digests: [digest("d")],
    storage_scope: "local",
    ...overrides,
  };
}

function candidate(overrides: Partial<EvalCandidate> = {}): EvalCandidate {
  return {
    schema_version: 1,
    candidate_id: "01925b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:06:00Z",
    skill_id: "pragman:review",
    skill_digest: digest("a"),
    corpus_id: "review-failures",
    source_event_digests: [digest("e")],
    failure_codes: ["verification-failed"],
    redacted_artifact_alias: "artifact-one",
    redacted_artifact_digest: digest("f"),
    approval_status: "pending",
    storage_scope: "local",
    append_only: true,
    ...overrides,
  };
}

function approval(overrides: Partial<EvalCandidateApproval> = {}): EvalCandidateApproval {
  const sourceCandidate = candidate();
  return {
    schema_version: 1,
    approval_id: "01935b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:07:00Z",
    candidate_id: sourceCandidate.candidate_id,
    candidate_digest: sha256Digest(sourceCandidate),
    decision: "approved",
    approval_source: "user",
    reviewed_redacted_artifact_digest: sourceCandidate.redacted_artifact_digest,
    storage_scope: "local",
    append_only: true,
    ...overrides,
  };
}

const fixtures: ReadonlyArray<[DurableRecordType, DurableRecord]> = [
  ["skill-events", event()],
  ["scores", score()],
  ["eval-candidates", candidate()],
  ["candidate-approvals", approval()],
];

test("resolves configured roots and constructs contained UTC date partitions", async () => {
  const configuredRoot = join(root, "nested", "..", "state");
  const resolvedRoot = await resolveStateRoot(configuredRoot);
  const partition = await resolvePartitionPath(configuredRoot, "skill-events", "2026-08-10T23:59:59Z");

  assert.equal(resolvedRoot, await realpath(join(root, "state")));
  assert.equal(partition, join(resolvedRoot, "skill-events", "2026-08-10.jsonl"));
  assert.equal(partition.startsWith(`${resolvedRoot}/`), true);
});

test("rejects the filesystem root as a state root", async () => {
  await assert.rejects(resolveStateRoot("/"), { code: "UNSAFE_STATE_ROOT" });
  await assert.rejects(appendDurable("/", "skill-events", event()), { code: "UNSAFE_STATE_ROOT" });
});

test("rejects invalid partitions and records that do not match their durable type", async () => {
  await assert.rejects(resolvePartitionPath(root, "skill-events", "2026-02-31"), {
    code: "INVALID_PARTITION_DATE",
  });
  await assert.rejects(appendDurable(root, "skill-events", score()), { code: "RECORD_INVALID" });
});

test("rejects an unrecognized runtime record type before creating any escaped directory", async () => {
  const escapedName = `${basename(root)}-escaped`;
  const escapedPath = join(dirname(root), escapedName);
  await assert.rejects(
    resolvePartitionPath(root, `../${escapedName}` as DurableRecordType, "2026-08-10"),
    { code: "INVALID_RECORD_TYPE" },
  );
  await assert.rejects(stat(escapedPath), { code: "ENOENT" });
});

test("rejects record-directory and partition-file symlinks that escape the selected root", async () => {
  const outside = await temporaryDirectory("pragman-events-outside-");
  const directoryEscapeRoot = join(root, "directory-escape");
  await mkdir(directoryEscapeRoot, { recursive: true });
  await symlink(outside, join(directoryEscapeRoot, "skill-events"));
  await assert.rejects(appendDurable(directoryEscapeRoot, "skill-events", event()), { code: "PATH_ESCAPE" });

  const fileEscapeRoot = join(root, "file-escape");
  await mkdir(join(fileEscapeRoot, "skill-events"), { recursive: true });
  const outsideFile = join(outside, "outside.jsonl");
  await writeFile(outsideFile, "", "utf8");
  await symlink(outsideFile, join(fileEscapeRoot, "skill-events", "2026-08-10.jsonl"));
  await assert.rejects(appendDurable(fileEscapeRoot, "skill-events", event()), { code: "PATH_ESCAPE" });
});

test("never follows a quarantine-directory symlink outside the selected root", async () => {
  const outside = await temporaryDirectory("pragman-events-quarantine-outside-");
  await appendDurable(root, "skill-events", event());
  await symlink(outside, join(root, "quarantine"));

  await assert.rejects(
    appendDurable(root, "skill-events", event({ skill_version: "2.0.0" })),
    { code: "PATH_ESCAPE" },
  );
  assert.deepEqual(await readdir(outside), []);
});

test("writes one canonical JSON record per line for every durable record type", async () => {
  for (const [recordType, record] of fixtures) {
    const result = await appendDurable(root, recordType, record);
    assert.equal(result.status, "appended");
    assert.equal(result.digest, sha256Digest(record));
    assert.equal(await readFile(result.partitionPath, "utf8"), `${canonicalJson(record)}\n`);

    const read = await readPartition<DurableRecord>(root, recordType, "2026-08-10");
    assert.deepEqual(read.records, [record]);
    assert.deepEqual(read.quarantined, []);
  }
});

test("syncs a durable append before returning", async () => {
  const probePath = join(root, "sync-probe");
  const probe = await open(probePath, "w");
  const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  const originalSync = prototype.sync;
  let syncCalls = 0;
  prototype.sync = async function sync(this: unknown) {
    syncCalls += 1;
    await originalSync.call(this);
  };
  await probe.close();

  try {
    await appendDurable(root, "skill-events", event());
  } finally {
    prototype.sync = originalSync;
  }
  assert.equal(syncCalls, 1);
});

test("treats exact duplicate IDs and digests as idempotent for every record type", async () => {
  for (const [recordType, record] of fixtures) {
    assert.equal((await appendDurable(root, recordType, record)).status, "appended");
    const duplicate = await appendDurable(root, recordType, structuredClone(record));
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.digest, sha256Digest(record));

    const read = await readPartition<DurableRecord>(root, recordType, "2026-08-10");
    assert.equal(read.records.length, 1);
  }
});

test("quarantines divergent duplicate identities without appending them", async () => {
  const original = event();
  await appendDurable(root, "skill-events", original);
  const collision = await appendDurable(root, "skill-events", event({ skill_version: "2.0.0" }));

  assert.equal(collision.status, "quarantined");
  assert.equal(collision.reason, "IDENTITY_COLLISION");
  const read = await readPartition<SkillEvent>(root, "skill-events", "2026-08-10");
  assert.deepEqual(read.records, [original]);
  const quarantineFiles = await readdir(join(root, "quarantine"));
  assert.equal(quarantineFiles.length, 1);
});

test("serializes concurrent writers through one state-root mutation lock", async () => {
  const records = Array.from({ length: 24 }, (_, index) => event({
    event_id: `${index.toString(16).padStart(8, "0")}-7f2d-7a51-a9c0-1d4cb73b10ab`,
    invocation_id: `${(index + 100).toString(16).padStart(8, "0")}-7f2d-7a51-a9c0-1d4cb73b10ab`,
  }));

  const results = await Promise.all(records.map((record) => appendDurable(root, "skill-events", record)));
  assert.equal(results.every((result) => result.status === "appended"), true);
  const read = await readPartition<SkillEvent>(root, "skill-events", "2026-08-10");
  assert.equal(read.records.length, records.length);
  assert.deepEqual(new Set(read.records.map((record) => record.event_id)), new Set(records.map((record) => record.event_id)));
});

test("quarantines and removes only a malformed final fragment while preserving the valid prefix", async () => {
  const original = event();
  const append = await appendDurable(root, "skill-events", original);
  const validPrefix = await readFile(append.partitionPath, "utf8");
  const handle = await open(append.partitionPath, "a");
  await handle.write("{\"event_id\":");
  await handle.close();

  const read = await readPartition<SkillEvent>(root, "skill-events", "2026-08-10");
  assert.deepEqual(read.records, [original]);
  assert.deepEqual(read.quarantined.map((entry) => entry.reason), ["MALFORMED_TAIL"]);
  assert.equal(await readFile(append.partitionPath, "utf8"), validPrefix);
  const quarantinePath = join(root, "quarantine", read.quarantined[0]!.fileName);
  assert.equal(await readFile(quarantinePath, "utf8"), "{\"event_id\":");
});

test("reader quarantines an invalid identity record without changing any prior line", async () => {
  const original = event();
  const append = await appendDurable(root, "skill-events", original);
  const originalLine = `${canonicalJson(original)}\n`;
  const divergent = event({ skill_version: "3.0.0" });
  const handle = await open(append.partitionPath, "a");
  await handle.write(`${canonicalJson(divergent)}\n`);
  await handle.close();

  const read = await readPartition<SkillEvent>(root, "skill-events", "2026-08-10");
  assert.deepEqual(read.records, [original]);
  assert.deepEqual(read.quarantined.map((entry) => entry.reason), ["IDENTITY_COLLISION"]);
  assert.equal((await readFile(append.partitionPath, "utf8")).startsWith(originalLine), true);
  assert.equal(dirname(append.partitionPath), join(await resolveStateRoot(root), "skill-events"));
});

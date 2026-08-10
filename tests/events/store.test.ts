import assert from "node:assert/strict";
import { open, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { channel } from "node:diagnostics_channel";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";

import {
  appendDurable,
  appendBestEffort,
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
import {
  createLocalBestEffortDependencies,
  mutateDurableRecord,
} from "../../packages/events/src/store.ts";
import { loadRetentionState } from "../../packages/cli/src/commands/events.ts";
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

test("never follows a sharded-index ancestor symlink outside the selected root", async () => {
  const outside = await temporaryDirectory("pragman-events-index-outside-");
  await writeFile(join(outside, "meta.json"), `${canonicalJson({ schema_version: 1, index_version: 2 })}\n`);
  await symlink(outside, join(root, ".events-index"));

  await assert.rejects(mutateDurableRecord(root, "skill-events", event()), { code: "PATH_ESCAPE" });
  assert.deepEqual(await readdir(outside), ["meta.json"]);
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
  assert.equal(syncCalls >= 1, true);
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

test("quarantines divergent duplicate identities across the complete state root", async () => {
  const original = event();
  await appendDurable(root, "skill-events", original);
  const collision = await appendDurable(root, "skill-events", event({
    skill_version: "2.0.0",
    timestamp: "2026-08-11T12:00:00Z",
  }));

  assert.equal(collision.status, "quarantined");
  assert.equal(collision.reason, "IDENTITY_COLLISION");
  const read = await readPartition<SkillEvent>(root, "skill-events", "2026-08-10");
  assert.deepEqual(read.records, [original]);
  assert.deepEqual((await readPartition<SkillEvent>(root, "skill-events", "2026-08-11")).records, []);
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
  const envelope = JSON.parse(await readFile(quarantinePath, "utf8"));
  assert.deepEqual(envelope, {
    schema_version: 1,
    reason: "MALFORMED_TAIL",
    record_type: "skill-events",
    content_digest: sha256Digest("{\"event_id\":"),
    content_bytes: 12,
  });
  assert.equal(JSON.stringify(envelope).includes("event_id"), false);
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

test("partition repair invalidates a shard that indexed the removed collision", async () => {
  const original = event();
  const append = await appendDurable(root, "skill-events", original);
  const divergent = event({ skill_version: "3.0.0" });
  const stateRoot = await resolveStateRoot(root);
  const identityShard = join(
    stateRoot,
    ".events-index",
    "identity",
    "skill-events",
    `${sha256Digest(original.event_id)}.json`,
  );
  await writeFile(identityShard, `${canonicalJson({
    schema_version: 1,
    record_type: "skill-events",
    identity: original.event_id,
    digest: sha256Digest(divergent),
  })}\n`);
  const handle = await open(append.partitionPath, "a");
  await handle.write(`${canonicalJson(divergent)}\n`);
  await handle.close();

  assert.deepEqual((await readPartition<SkillEvent>(root, "skill-events", "2026-08-10")).records, [original]);
  assert.equal((await mutateDurableRecord(root, "skill-events", divergent)).status, "quarantined");
});

test("reader quarantines a complete schema-invalid line and never trusts additional fields", async () => {
  const original = event();
  const append = await appendDurable(root, "skill-events", original);
  const invalid = { ...event({
    event_id: "02905c8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    invocation_id: "02905d8c-7f2d-7a51-a9c0-1d4cb73b10ab",
  }), prompt: "must-not-be-trusted" };
  const handle = await open(append.partitionPath, "a");
  await handle.write(`${JSON.stringify(invalid)}\n`);
  await handle.close();

  const read = await readPartition<SkillEvent>(root, "skill-events", "2026-08-10");
  assert.deepEqual(read.records, [original]);
  assert.deepEqual(read.quarantined.map((entry) => entry.reason), ["SCHEMA_INVALID"]);
  assert.equal(JSON.stringify(read.records).includes("must-not-be-trusted"), false);
  const quarantine = await readFile(join(root, "quarantine", read.quarantined[0]!.fileName), "utf8");
  assert.equal(quarantine.includes("must-not-be-trusted"), false);
  assert.equal(JSON.parse(quarantine).reason, "SCHEMA_INVALID");
  const partition = await readFile(append.partitionPath, "utf8");
  assert.equal(partition.includes("must-not-be-trusted"), false);
  const stateFiles: string[] = [];
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) stateFiles.push(path);
    }
  }
  await collect(root);
  for (const path of stateFiles) assert.equal((await readFile(path, "utf8")).includes("must-not-be-trusted"), false, path);
});

test("retention state includes quarantine entries created while partitions are loading", async () => {
  const append = await appendDurable(root, "skill-events", event());
  const invalidLine = JSON.stringify({ ...event({
    event_id: "05905e8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    invocation_id: "05905f8c-7f2d-7a51-a9c0-1d4cb73b10ab",
  }), raw_content: "never-copy-this" });
  const handle = await open(append.partitionPath, "a");
  await handle.write(`${invalidLine}\n`);
  await handle.close();

  const state = await loadRetentionState(root);
  assert.equal(state.events.length, 1);
  assert.equal(state.quarantine.length, 1);
  assert.equal((await readFile(join(root, "quarantine", state.quarantine[0]!.quarantine_id), "utf8")).includes("never-copy-this"), false);
});

test("transactional mutation serializes competing terminal events", async () => {
  await mutateDurableRecord(root, "skill-events", event());
  const completed = event({
    event_id: "02905e8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    event_type: "completed",
    timestamp: "2026-08-10T12:01:00Z",
    status: "succeeded",
  });
  const cancelled = event({
    event_id: "03905e8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    event_type: "cancelled",
    timestamp: "2026-08-10T12:01:00Z",
    status: "cancelled",
  });

  const results = await Promise.all([
    mutateDurableRecord(root, "skill-events", completed),
    mutateDurableRecord(root, "skill-events", cancelled),
  ]);
  assert.equal(results.filter((result) => result.status === "appended").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(results.find((result) => result.status === "rejected")?.reason, "TERMINAL_EVENT_EXISTS");
  assert.equal((await readPartition<SkillEvent>(root, "skill-events", "2026-08-10")).records.length, 2);
});

test("transactional mutation quarantines competing score forks", async () => {
  await mutateDurableRecord(root, "skill-events", event());
  const original = score();
  await mutateDurableRecord(root, "scores", original);
  const corrections = ["2", "3"].map((prefix, index) => score({
    score_id: `0${prefix}915b8c-7f2d-7a51-a9c0-1d4cb73b10ab`,
    timestamp: `2026-08-${11 + index}T12:05:00Z`,
    supersedes_score_id: original.score_id,
    value: false,
  }));

  const results = await Promise.all(corrections.map((record) => mutateDurableRecord(root, "scores", record)));
  assert.equal(results.filter((result) => result.status === "appended").length, 1);
  assert.equal(results.filter((result) => result.status === "quarantined").length, 1);
  assert.equal(results.find((result) => result.status === "quarantined")?.reason, "SCORE_FORK");
});

test("transactional mutation permits only one candidate decision", async () => {
  const sourceCandidate = candidate();
  await mutateDurableRecord(root, "eval-candidates", sourceCandidate);
  const decisions = ["approved", "rejected"].map((decision, index) => approval({
    approval_id: `0${index + 4}935b8c-7f2d-7a51-a9c0-1d4cb73b10ab`,
    decision: decision as "approved" | "rejected",
  }));
  const results = await Promise.all(decisions.map((record) => mutateDurableRecord(root, "candidate-approvals", record)));
  assert.equal(results.filter((result) => result.status === "appended").length, 1);
  assert.equal(results.filter((result) => result.status === "quarantined").length, 1);
  assert.equal(results.find((result) => result.status === "quarantined")?.reason, "CANDIDATE_ALREADY_DECIDED");
});

test("recovers a stale owner lock and bounds contention on a live owner", async () => {
  const stateRoot = await resolveStateRoot(root);
  await writeFile(join(stateRoot, ".events-mutation.lock"), JSON.stringify({
    schema_version: 1,
    owner_pid: 99_999_999,
    owner_started_at: "2026-01-01T00:00:00.000Z",
    owner_process_start_identity: "missing-process",
    owner_token: "stale-owner",
  }));
  assert.equal((await mutateDurableRecord(root, "skill-events", event())).status, "appended");

  const dependencies = await createLocalBestEffortDependencies(root);
  const probeLock = await dependencies.acquireLock(20);
  assert.ok(probeLock);
  const liveMetadata = JSON.parse(await readFile(join(stateRoot, ".events-mutation.lock"), "utf8"));
  await probeLock.release();

  await writeFile(join(stateRoot, ".events-mutation.lock"), JSON.stringify({
    schema_version: 1,
    owner_pid: process.pid,
    owner_started_at: new Date().toISOString(),
    owner_process_start_identity: `${liveMetadata.owner_process_start_identity}-reused`,
    owner_token: "reused-pid-owner",
  }));
  assert.equal((await mutateDurableRecord(root, "skill-events", event({
    event_id: "04905e8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    invocation_id: "04905f8c-7f2d-7a51-a9c0-1d4cb73b10ab",
  }), { lockTimeoutMs: 100 })).status, "appended");

  await writeFile(join(stateRoot, ".events-mutation.lock"), JSON.stringify({
    schema_version: 1,
    owner_pid: process.pid,
    owner_started_at: new Date().toISOString(),
    owner_process_start_identity: liveMetadata.owner_process_start_identity,
    owner_token: "live-owner",
  }));
  const started = Date.now();
  await assert.rejects(mutateDurableRecord(root, "skill-events", event({
    event_id: "04905e8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    invocation_id: "04905f8c-7f2d-7a51-a9c0-1d4cb73b10ab",
  }), { lockTimeoutMs: 20 }), { code: "LOCK_TIMEOUT" });
  assert.ok(Date.now() - started < 250);
  await unlink(join(stateRoot, ".events-mutation.lock"));
});

test("steady-state append touches only its identity and invocation shards as history grows", async () => {
  for (let index = 0; index < 40; index += 1) {
    await mutateDurableRecord(root, "skill-events", event({
      event_id: `${(index + 100).toString(16).padStart(8, "0")}-7f2d-7a51-a9c0-1d4cb73b10ab`,
      invocation_id: `${(index + 200).toString(16).padStart(8, "0")}-7f2d-7a51-a9c0-1d4cb73b10ab`,
    }));
  }
  const observed: Array<{ operation: string; path: string }> = [];
  const io = channel("pragman.events.store.io");
  const listener = (message: unknown) => observed.push(message as { operation: string; path: string });
  io.subscribe(listener);
  try {
    const result = await mutateDurableRecord(root, "skill-events", event({
      event_id: "06905e8c-7f2d-7a51-a9c0-1d4cb73b10ab",
      invocation_id: "06905f8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    }));
    assert.equal(result.status, "appended");
  } finally {
    io.unsubscribe(listener);
  }
  assert.equal(observed.filter((entry) => entry.operation === "read" && entry.path.endsWith(".jsonl")).length, 0);
  assert.ok(observed.length <= 12, JSON.stringify(observed));
  const indexReads = observed.filter((entry) => entry.operation === "read" && entry.path.includes(".events-index/"));
  assert.equal(indexReads.every((entry) => /meta\.json|identity\/skill-events\/|invocations\//.test(entry.path)), true);
});

test("a corrupt sharded index bootstraps once from append-only partitions", async () => {
  const first = await mutateDurableRecord(root, "skill-events", event());
  const stateRoot = await resolveStateRoot(root);
  const metaPath = join(stateRoot, ".events-index", "meta.json");
  await writeFile(metaPath, "{broken");
  const secondInvocation = event({
    event_id: "07905e8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    invocation_id: "07905f8c-7f2d-7a51-a9c0-1d4cb73b10ab",
  });
  const handle = await open(first.partitionPath, "a");
  await handle.write(`${canonicalJson(secondInvocation)}\n`);
  await handle.close();

  const terminal = event({
    ...secondInvocation,
    event_id: "08905e8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:01:00Z",
    event_type: "completed",
    status: "succeeded",
  });
  assert.equal((await mutateDurableRecord(root, "skill-events", terminal)).status, "appended");
  assert.equal((await readPartition<SkillEvent>(root, "skill-events", "2026-08-10")).records.length, 3);
  assert.deepEqual(JSON.parse(await readFile(metaPath, "utf8")), { schema_version: 1, index_version: 2 });
});

test("a corrupt affected shard is rebuilt from the append-only partition", async () => {
  const invoked = event();
  await mutateDurableRecord(root, "skill-events", invoked);
  const stateRoot = await resolveStateRoot(root);
  const invocationShard = join(
    stateRoot,
    ".events-index",
    "invocations",
    `${sha256Digest(invoked.invocation_id)}.json`,
  );
  await writeFile(invocationShard, "{broken");

  const terminal = event({
    event_id: "09905e8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:01:00Z",
    event_type: "completed",
    status: "succeeded",
  });
  assert.equal((await mutateDurableRecord(root, "skill-events", terminal)).status, "appended");
  assert.deepEqual(
    (await readPartition<SkillEvent>(root, "skill-events", "2026-08-10")).records,
    [invoked, terminal],
  );
});

test("provides a concrete local dependency adapter for bounded observers", async () => {
  const probe = await open(join(root, "best-effort-sync-probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  const originalSync = prototype.sync;
  let syncCalls = 0;
  prototype.sync = async function delayedSync() {
    syncCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  await probe.close();

  try {
    const dependencies = await createLocalBestEffortDependencies(root);
    assert.deepEqual(await appendBestEffort(dependencies, event()), { recorded: true, reason: null });
  } finally {
    prototype.sync = originalSync;
  }
  assert.equal(syncCalls, 0);
  assert.equal((await readPartition<SkillEvent>(root, "skill-events", "2026-08-10")).records.length, 1);
});

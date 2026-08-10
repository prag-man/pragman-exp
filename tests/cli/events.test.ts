import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../../packages/cli/src/args.ts";
import {
  aggregateWeeklyRollups,
  appendDurable,
  buildDailyRollups,
  loadEventSettings,
  observeSkillEvent,
  resolveMeasurementSettings,
  sha256Digest,
  type SkillEvent,
  type SkillScore,
} from "../../packages/events/src/index.ts";

const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;
const digest = (character: string) => character.repeat(64);

function validEvent(): SkillEvent {
  return {
    schema_version: 1, event_id: "018f5b8c-7f2d-7a51-a9c0-1d4cb73b10ab", invocation_id: "01905b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:00:00Z", event_type: "invoked", skill_id: "pragman:review", skill_version: "1.0.0",
    skill_digest: digest("a"), skill_type: "capability", host: "codex", host_version: "1", model: "gpt", model_version: "1",
    harness_version: "1", invocation_mode: "host", session_id: null, route_id: null, eval_id: null, case_id: null, trial_id: null,
    provider: null, ablation_arm: "production", trigger_expected: null, trigger_actual: true, provider_digest: null,
    eval_corpus_digest: null, trial_policy_digest: null, status: null, outcome_code: null, duration_ms: 0, tool_calls: 0,
    retries: 0, rework_cycles: 0, verification_checks: 0, verification_passes: 0, observation_source: "cli", source_aliases: [],
    storage_scope: "local", append_only: true,
  };
}

function personal(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    privacy: { default_sensitivity: "internal" },
    updates: { channel: "stable" },
    output: { format: "human" },
    ...overrides,
  };
}

async function writeRollupFixture(root: string): Promise<void> {
  await mkdir(join(root, "rollups", "daily"), { recursive: true });
  await mkdir(join(root, "rollups", "weekly"), { recursive: true });
  const invoked = validEvent();
  const completed: SkillEvent = {
    ...invoked,
    event_id: "028f5b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:01:00Z",
    event_type: "completed",
    status: "succeeded",
  };
  const daily = buildDailyRollups([invoked, completed], [], new Map(), "2026-08-10");
  const weekly = aggregateWeeklyRollups(daily, "2026-08-10");
  await writeFile(join(root, "rollups", "daily", "2026-08-10.json"), JSON.stringify(daily));
  await writeFile(join(root, "rollups", "weekly", "2026-08-10.json"), JSON.stringify(weekly));
}

test("settings default local events independently from remote telemetry", () => {
  const retention_policy = { raw_days: 180, candidate_days: 180, quarantine_days: 30, daily_rollup_days: 730, plan_ttl_ms: 600_000 };
  assert.deepEqual(resolveMeasurementSettings(personal()), { ok: true, local_events: true, telemetry_enabled: false, retention_policy });
  assert.deepEqual(resolveMeasurementSettings(personal({ measurement: {} })), { ok: true, local_events: true, telemetry_enabled: false, retention_policy });
  assert.deepEqual(resolveMeasurementSettings(personal({ measurement: { local_events: false } })), { ok: true, local_events: false, telemetry_enabled: false, retention_policy });
});

test("settings resolve bounded user-shortened retention without allowing longer history", () => {
  const shortened = resolveMeasurementSettings(personal({
    measurement: {
      local_events: true,
      retention: { raw_days: 90, candidate_days: 120, quarantine_days: 7, daily_rollup_days: 365 },
    },
  }));
  assert.equal(shortened.ok, true);
  if (shortened.ok) assert.deepEqual(shortened.retention_policy, {
    raw_days: 90,
    candidate_days: 120,
    quarantine_days: 7,
    daily_rollup_days: 365,
    plan_ttl_ms: 600_000,
  });
  assert.equal(resolveMeasurementSettings(personal({
    measurement: { local_events: true, retention: { raw_days: 181 } },
  })).ok, false);
});

test("settings parse selected YAML and JSON paths and fail closed on malformed or newer config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-settings-"));
  const yamlPath = join(root, "config.yaml");
  const jsonPath = join(root, "config.json");
  await writeFile(yamlPath, "schema_version: 1\nprivacy:\n  default_sensitivity: internal\nupdates:\n  channel: stable\noutput:\n  format: human\nmeasurement:\n  local_events: false\n");
  await writeFile(jsonPath, JSON.stringify(personal()));
  assert.equal((await loadEventSettings(yamlPath)).local_events, false);
  assert.equal((await loadEventSettings(jsonPath)).local_events, true);
  await writeFile(jsonPath, "{broken");
  assert.deepEqual(await loadEventSettings(jsonPath), { ok: false, code: "CONFIG_INVALID", config_path: jsonPath, local_events: false, telemetry_enabled: false });
  await writeFile(jsonPath, JSON.stringify({ ...personal(), schema_version: 2 }));
  assert.equal((await loadEventSettings(jsonPath)).code, "CONFIG_VERSION_UNSUPPORTED");
});

test("disabled best-effort observation performs no write and cannot affect primary work", async () => {
  let writes = 0;
  const result = await observeSkillEvent({ ok: true, local_events: false, telemetry_enabled: false }, {} as SkillEvent, {
    now: () => 0, delay: async () => undefined, acquireLock: async () => null,
    appendUnlocked: async () => { writes += 1; },
  });
  assert.deepEqual(result, { recorded: false, reason: "DISABLED" });
  assert.equal(writes, 0);
  assert.equal("primary_result" in result, false);
});

test("argument grammar recognizes event and eval commands without accepting JSON content as arguments", () => {
  for (const command of [
    ["events", "record"], ["events", "score"], ["events", "list"], ["events", "summary"],
    ["events", "rebuild"], ["events", "export"], ["events", "purge"],
    ["events", "candidates", "list"], ["events", "candidates", "decide"],
    ["eval", "run"], ["eval", "compare"],
  ]) assert.notEqual(parseArguments(command).command, "invalid", command.join(" "));
  assert.equal(parseArguments(["events", "record", '{"prompt":"private"}']).command, "invalid");
  assert.equal(parseArguments(["--version"]).command, "version");
});

test("durable record accepts stdin JSON and preserves the stable JSON envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-cli-events-"));
  const result = spawnSync(process.execPath, [cli, "events", "record", "--state-root", root, "--json"], {
    encoding: "utf8", input: JSON.stringify(validEvent()),
  });
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "events.record");
  assert.equal(envelope.data.recorded, true);
});

test("disabled durable record discloses no write until an explicit one-command override", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-cli-disabled-"));
  const config = join(root, "config.yaml");
  await writeFile(config, "schema_version: 1\nprivacy:\n  default_sensitivity: internal\nupdates:\n  channel: stable\noutput:\n  format: human\nmeasurement:\n  local_events: false\n");
  const disabled = spawnSync(process.execPath, [cli, "events", "record", "--state-root", join(root, "state"), "--config", config, "--json"], { encoding: "utf8", input: JSON.stringify(validEvent()) });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(JSON.parse(disabled.stdout).data, { recorded: false, reason: "DISABLED", override_available: true });
  const override = spawnSync(process.execPath, [cli, "events", "record", "--state-root", join(root, "state"), "--config", config, "--override-local-events", "--json"], { encoding: "utf8", input: JSON.stringify(validEvent()) });
  assert.equal(override.status, 0, override.stderr);
  assert.equal(JSON.parse(override.stdout).data.recorded, true);
});

test("raw export and destructive purge expose preview approval boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-cli-preview-"));
  const raw = spawnSync(process.execPath, [cli, "events", "export", "--raw", "--state-root", root, "--json", "--non-interactive"], { encoding: "utf8" });
  assert.equal(raw.status, 3, raw.stderr);
  assert.equal(JSON.parse(raw.stdout).error.code, "NEEDS_APPROVAL");
  const purge = spawnSync(process.execPath, [cli, "events", "purge", "--class", "raw", "--from", "2026-01-01", "--through", "2026-01-31", "--state-root", root, "--json"], { encoding: "utf8" });
  assert.equal(purge.status, 0, purge.stderr);
  assert.match(JSON.parse(purge.stdout).data.preview_digest, /^[a-f0-9]{64}$/);
});

test("privacy-bearing event input uses the denial exit class", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-cli-privacy-"));
  const result = spawnSync(process.execPath, [cli, "events", "record", "--state-root", root, "--json"], {
    encoding: "utf8", input: JSON.stringify({ ...validEvent(), prompt: "private task content" }),
  });
  assert.equal(result.status, 5, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "PRIVACY_DENIED");
});

test("events list returns a bounded de-identified projection instead of raw durable records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-cli-list-privacy-"));
  const recorded = spawnSync(process.execPath, [cli, "events", "record", "--state-root", root, "--json"], {
    encoding: "utf8", input: JSON.stringify(validEvent()),
  });
  assert.equal(recorded.status, 0, recorded.stderr);
  const listed = spawnSync(process.execPath, [cli, "events", "list", "--state-root", root, "--json"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const envelope = JSON.parse(listed.stdout);
  const serialized = JSON.stringify(envelope.data);
  assert.equal(serialized.includes(validEvent().event_id), false);
  assert.equal(serialized.includes(validEvent().invocation_id), false);
  assert.equal(serialized.includes(digest("a")), false);
  assert.equal(serialized.includes("source_aliases"), false);
  assert.ok(envelope.data.records.length <= 100);
  assert.deepEqual(Object.keys(envelope.data.records[0]).sort(), [
    "event_type", "host", "invocation_mode", "observation_source", "skill_type", "status", "timestamp",
  ]);
});

test("export apply reloads under one lock and rejects a stale preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-cli-export-stale-"));
  const preview = spawnSync(process.execPath, [cli, "events", "export", "--state-root", root, "--json"], { encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stderr);
  const previewDigest = JSON.parse(preview.stdout).data.preview_digest;
  const changed = spawnSync(process.execPath, [cli, "events", "record", "--state-root", root, "--json"], {
    encoding: "utf8", input: JSON.stringify(validEvent()),
  });
  assert.equal(changed.status, 0, changed.stderr);
  const apply = spawnSync(process.execPath, [cli, "events", "export", "--apply", previewDigest, "--state-root", root, "--json"], { encoding: "utf8" });
  assert.equal(apply.status, 5, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).error.code, "STALE_STATE");
});

test("plan and rollup symlink escapes are denied", async () => {
  const outside = await mkdtemp(join(tmpdir(), "pragman-cli-outside-"));
  const planRoot = await mkdtemp(join(tmpdir(), "pragman-cli-plan-symlink-"));
  await symlink(outside, join(planRoot, "plans"));
  const preview = spawnSync(process.execPath, [cli, "events", "export", "--state-root", planRoot, "--json"], { encoding: "utf8" });
  assert.equal(preview.status, 5, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).error.code, "PRIVACY_DENIED");
  assert.deepEqual(await readdir(outside), []);

  const rollupRoot = await mkdtemp(join(tmpdir(), "pragman-cli-rollup-symlink-"));
  await symlink(outside, join(rollupRoot, "rollups"));
  const listed = spawnSync(process.execPath, [cli, "events", "list", "--state-root", rollupRoot, "--json"], { encoding: "utf8" });
  assert.equal(listed.status, 5, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).error.code, "PRIVACY_DENIED");
});

test("purge apply persists daily and weekly rollup deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-cli-rollup-purge-"));
  await writeRollupFixture(root);
  const preview = spawnSync(process.execPath, [cli, "events", "purge", "--class", "daily-rollups", "--class", "weekly-rollups", "--from", "2020-01-01", "--through", "2030-12-31", "--state-root", root, "--json"], { encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stderr);
  const previewDigest = JSON.parse(preview.stdout).data.preview_digest;
  const apply = spawnSync(process.execPath, [cli, "events", "purge", "--apply", previewDigest, "--state-root", root, "--json"], { encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  assert.deepEqual(await readdir(join(root, "rollups", "daily")), []);
  assert.deepEqual(await readdir(join(root, "rollups", "weekly")), []);
});

test("an interrupted cross-class replacement is recovered before the next read", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-cli-purge-crash-"));
  await writeRollupFixture(root);
  const preview = spawnSync(process.execPath, [cli, "events", "purge", "--class", "daily-rollups", "--class", "weekly-rollups", "--from", "2020-01-01", "--through", "2030-12-31", "--state-root", root, "--json"], { encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stderr);
  const previewDigest = JSON.parse(preview.stdout).data.preview_digest;
  const interrupted = spawnSync(process.execPath, [cli, "events", "purge", "--apply", previewDigest, "--state-root", root, "--json"], {
    encoding: "utf8",
    env: { ...process.env, PRAGMAN_EVENTS_TEST_CRASH_AFTER_SWAP: "1" },
  });
  assert.equal(interrupted.status, 6, interrupted.stderr);
  const recovered = spawnSync(process.execPath, [cli, "events", "list", "--state-root", root, "--json"], { encoding: "utf8" });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(await readdir(join(root, "rollups", "daily")), []);
  assert.deepEqual(await readdir(join(root, "rollups", "weekly")), []);
});

test("events summary applies shortened automatic retention after sealing daily and recomputing weekly rollups", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-cli-auto-retention-"));
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify(personal({
    measurement: { local_events: true, retention: { raw_days: 1 } },
  })));
  const invoked = { ...validEvent(), timestamp: "2025-01-01T12:00:00Z" };
  const completed: SkillEvent = {
    ...invoked,
    event_id: "038f5b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2025-01-01T12:01:00Z",
    event_type: "completed",
    status: "succeeded",
  };
  for (const record of [invoked, completed]) {
    const result = spawnSync(process.execPath, [cli, "events", "record", "--state-root", join(root, "state"), "--config", config, "--json"], {
      encoding: "utf8", input: JSON.stringify(record),
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const summary = spawnSync(process.execPath, [cli, "events", "summary", "--state-root", join(root, "state"), "--config", config, "--json"], { encoding: "utf8" });
  assert.equal(summary.status, 0, summary.stderr);
  const data = JSON.parse(summary.stdout).data;
  assert.equal(data.retention.applied, true);
  assert.equal(data.retention.removed_counts.event_ids, 2);
  assert.deepEqual(await readdir(join(root, "state", "skill-events")), []);
  const dailyFiles = await readdir(join(root, "state", "rollups", "daily"));
  const weeklyFiles = await readdir(join(root, "state", "rollups", "weekly"));
  assert.ok(dailyFiles.length > 0);
  assert.ok(weeklyFiles.length > 0);
  const daily = JSON.parse(await readFile(join(root, "state", "rollups", "daily", dailyFiles[0]), "utf8"));
  assert.equal(daily.every((rollup: { sealed: boolean }) => rollup.sealed), true);
});

test("events summary reports bounded retention debt without blocking the read or deleting raw state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-cli-retention-debt-"));
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify(personal({
    measurement: { local_events: true, retention: { raw_days: 1 } },
  })));
  const invoked = { ...validEvent(), timestamp: "2025-01-01T12:00:00Z" };
  const recorded = spawnSync(process.execPath, [cli, "events", "record", "--state-root", join(root, "state"), "--config", config, "--json"], {
    encoding: "utf8", input: JSON.stringify(invoked),
  });
  assert.equal(recorded.status, 0, recorded.stderr);
  const summary = spawnSync(process.execPath, [cli, "events", "summary", "--state-root", join(root, "state"), "--config", config, "--json"], {
    encoding: "utf8",
    env: { ...process.env, PRAGMAN_EVENTS_TEST_RETENTION_DEBT_DAY: "2025-01-01" },
  });
  assert.equal(summary.status, 0, summary.stderr);
  const data = JSON.parse(summary.stdout).data;
  assert.equal(data.observed_invocations, 1);
  assert.deepEqual(data.retention, {
    applied: false,
    reason: "RETENTION_DEBT",
    debt: { seal_and_verify_days: ["2025-01-01"], recompute_week_starts: [] },
    truncated: false,
  });
  assert.deepEqual(await readdir(join(root, "state", "skill-events")), ["2025-01-01.jsonl"]);
});

test("events summary surfaces unavailable historical metric debt and preserves its raw cohort", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-cli-metric-retention-debt-"));
  const stateRoot = join(root, "state");
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify(personal({
    measurement: { local_events: true, retention: { raw_days: 1 } },
  })));
  const invocation = { ...validEvent(), timestamp: "2025-01-01T12:00:00Z" };
  const recorded = spawnSync(process.execPath, [cli, "events", "record", "--state-root", stateRoot, "--config", config, "--json"], {
    encoding: "utf8", input: JSON.stringify(invocation),
  });
  assert.equal(recorded.status, 0, recorded.stderr);
  const score: SkillScore = {
    schema_version: 1,
    score_id: "01915b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2025-01-01T12:01:00Z",
    invocation_id: invocation.invocation_id,
    metric_id: "retired-metric",
    metric_definition_digest: digest("f"),
    value: true,
    value_type: "boolean",
    source: "deterministic",
    grader_id: "retired-grader",
    grader_version: "1",
    rubric_digest: digest("e"),
    evidence_digests: [digest("d")],
    storage_scope: "local",
  };
  assert.equal((await appendDurable(stateRoot, "scores", score)).status, "appended");

  const summary = spawnSync(process.execPath, [cli, "events", "summary", "--state-root", stateRoot, "--config", config, "--json"], { encoding: "utf8" });
  assert.equal(summary.status, 0, summary.stderr);
  const data = JSON.parse(summary.stdout).data;
  assert.deepEqual(data.retention, {
    applied: false,
    reason: "RETENTION_DEBT",
    debt: {
      unavailable_metric_definition_digests: [digest("f")],
      seal_and_verify_days: [],
      recompute_week_starts: [],
    },
    truncated: false,
  });
  assert.deepEqual(await readdir(join(stateRoot, "skill-events")), ["2025-01-01.jsonl"]);
  assert.deepEqual(await readdir(join(stateRoot, "scores")), ["2025-01-01.jsonl"]);
});

test("eval compare consumes content-free paired evidence through stdin", () => {
  const metric = {
    schema_version: 1, metric_id: "task-success", version: "1", description: "Task success", value_type: "boolean",
    boolean_values: [{ value: false, utility: 0 }, { value: true, utility: 1 }], direction: "maximize",
    pass_rule: { operator: "eq", value: true }, eligible_score_sources: ["deterministic"], eligible_verification_codes: [],
    lifecycle_policy: { minimum_trials_per_arm: 2, minimum_comparable_environments: 1, minimum_pass_rate: 0.8, regression_tolerance: 0.05, material_lift: 0.1, non_inferiority_margin: 0.02, efficiency_materiality: { duration_ms: 1, retries: 1, rework_cycles: 1, tool_calls: 1 } },
  };
  const common = { eval_id: "eval", eval_corpus_digest: digest("a"), trial_policy_digest: digest("b"), case_id: "case", trial_id: "trial", skill_digest: digest("c"), provider: "pragman:review", provider_digest: digest("d"), host: "codex", host_version: "1", model: "gpt", model_version: "1", harness_version: "1", metric_id: "task-success", metric_definition_digest: sha256Digest(metric), grader_id: "grader", grader_version: "1", rubric_digest: digest("f"), raw_value: true, verified_success: true, duration_ms: 1, retries: 0, rework_cycles: 0, tool_calls: 1 };
  const result = spawnSync(process.execPath, [cli, "eval", "compare", "--json"], { encoding: "utf8", input: JSON.stringify({ metric, trials: [{ ...common, arm: "skill-on" }, { ...common, arm: "skill-off", raw_value: false }] }) });
  assert.equal(result.status, 0, result.stderr);
  const comparison = JSON.parse(result.stdout).data;
  assert.equal(comparison.status, "COMPARABLE");
  assert.equal(comparison.outcome_lift, 1);
  assert.equal(comparison.pass_lift, 1);
  assert.equal("provider" in comparison.pairs[0].skill_on, false);
});

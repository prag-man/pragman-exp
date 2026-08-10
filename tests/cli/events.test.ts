import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../../packages/cli/src/args.ts";
import {
  loadEventSettings,
  observeSkillEvent,
  resolveMeasurementSettings,
  type SkillEvent,
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

test("settings default local events independently from remote telemetry", () => {
  assert.deepEqual(resolveMeasurementSettings(personal()), { ok: true, local_events: true, telemetry_enabled: false });
  assert.deepEqual(resolveMeasurementSettings(personal({ measurement: {} })), { ok: true, local_events: true, telemetry_enabled: false });
  assert.deepEqual(resolveMeasurementSettings(personal({ measurement: { local_events: false } })), { ok: true, local_events: false, telemetry_enabled: false });
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

test("eval compare consumes content-free paired evidence through stdin", () => {
  const common = { eval_id: "eval", eval_corpus_digest: digest("a"), trial_policy_digest: digest("b"), case_id: "case", trial_id: "trial", skill_digest: digest("c"), provider: "pragman:review", provider_digest: digest("d"), host: "codex", host_version: "1", model: "gpt", model_version: "1", harness_version: "1", metric_id: "task-success", metric_definition_digest: digest("e"), grader_id: "grader", grader_version: "1", rubric_digest: digest("f"), raw_value: true, utility: 1, passed: true, verified_success: true, duration_ms: 1, retries: 0, rework_cycles: 0, tool_calls: 1 };
  const result = spawnSync(process.execPath, [cli, "eval", "compare", "--json"], { encoding: "utf8", input: JSON.stringify({ trials: [{ ...common, arm: "skill-on" }, { ...common, arm: "skill-off", raw_value: false, utility: 0, passed: false }] }) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.status, "COMPARABLE");
});

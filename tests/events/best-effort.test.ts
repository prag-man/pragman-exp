import assert from "node:assert/strict";
import { test } from "node:test";
import { appendBestEffort, type BestEffortDependencies, type SkillEvent } from "../../packages/events/src/index.ts";

const digest = (character: string) => character.repeat(64);
const event: SkillEvent = {
  schema_version: 1, event_id: "00000001-7f2d-7a51-a9c0-1d4cb73b10ab", invocation_id: "10000001-7f2d-7a51-a9c0-1d4cb73b10ab",
  timestamp: "2026-08-10T12:00:00Z", event_type: "invoked", skill_id: "pragman:review", skill_version: "1",
  skill_digest: digest("a"), skill_type: "capability", host: "codex", host_version: "1", model: "gpt-5",
  model_version: "1", harness_version: "1", invocation_mode: "host", session_id: null, route_id: null, eval_id: null,
  case_id: null, trial_id: null, provider: "pragman:review", ablation_arm: "production", trigger_expected: null,
  trigger_actual: true, provider_digest: digest("b"), eval_corpus_digest: null, trial_policy_digest: null, status: null,
  outcome_code: null, duration_ms: 0, tool_calls: 0, retries: 0, rework_cycles: 0, verification_checks: 0,
  verification_passes: 0, observation_source: "host-adapter", source_aliases: [], storage_scope: "local", append_only: true,
};

function fakeDependencies(overrides: Partial<BestEffortDependencies> = {}) {
  let time = 0;
  const dependencies: BestEffortDependencies = {
    now: () => time,
    delay: async (milliseconds) => { time += milliseconds; },
    acquireLock: async () => ({ release: async () => undefined }),
    appendUnlocked: async () => undefined,
    ...overrides,
  };
  return { dependencies, time: () => time };
}

test("validates in memory and returns a bounded failure without touching the lock", async () => {
  let lockCalls = 0;
  const { dependencies } = fakeDependencies({ acquireLock: async () => { lockCalls += 1; return null; } });
  const result = await appendBestEffort(dependencies, { ...event, event_id: "invalid" });
  assert.deepEqual(result, { recorded: false, reason: "VALIDATION_FAILED" });
  assert.equal(lockCalls, 0);
});

test("stalled lock returns at the five millisecond lock budget without retry", async () => {
  let attempts = 0;
  const { dependencies, time } = fakeDependencies({ acquireLock: async () => { attempts += 1; return await new Promise(() => undefined); } });
  assert.deepEqual(await appendBestEffort(dependencies, event), { recorded: false, reason: "LOCK_TIMEOUT" });
  assert.equal(attempts, 1);
  assert.equal(time() <= 30, true);
});

test("stalled append returns by the total deadline and releases only when worker settles", async () => {
  let settle!: () => void;
  let released = 0;
  const stalled = new Promise<void>((resolve) => { settle = resolve; });
  const { dependencies, time } = fakeDependencies({
    acquireLock: async () => ({ release: async () => { released += 1; } }), appendUnlocked: async () => stalled,
  });
  assert.deepEqual(await appendBestEffort(dependencies, event), { recorded: false, reason: "DEADLINE_EXCEEDED" });
  assert.equal(time() <= 30, true);
  assert.equal(released, 0);
  settle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 1);
});

test("I/O failure is bounded and observation never changes the primary work result", async () => {
  const primary = { answer: 42 };
  const { dependencies } = fakeDependencies({ appendUnlocked: async () => { throw new Error("disk"); } });
  assert.deepEqual(await appendBestEffort(dependencies, event), { recorded: false, reason: "IO_ERROR" });
  assert.deepEqual(primary, { answer: 42 });
});

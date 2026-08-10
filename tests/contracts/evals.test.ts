import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runner = new URL("../../scripts/run-evals.mjs", import.meta.url).pathname;

const digest = (character: string) => character.repeat(64);
const taskSuccessMetricDigest = "4dff84ed68b9428d96917ab696529aa01e1ae754513413f3c245105d0492034d";

function skillEvaluationArm(
  arm: "skill-on" | "skill-off",
  overrides: Record<string, unknown> = {},
) {
  return {
    schema_version: 1,
    evaluation_mode: "skill-eval",
    arm,
    skill_type: "capability",
    eval_id: "review-release-v1",
    eval_corpus_digest: digest("a"),
    trial_policy_digest: digest("b"),
    skill_id: "pragman:review",
    skill_version: "1.2.3",
    skill_digest: digest("c"),
    provider: "pragman:builtin-review",
    provider_digest: digest("d"),
    environment_digest: digest("e"),
    host: "codex",
    host_version: "1.0.0",
    model: "gpt-5",
    model_version: "2026-08-01",
    harness_version: "1.0.0",
    metric_id: "task-success",
    metric_definition_digest: taskSuccessMetricDigest,
    grader_id: "deterministic-task-check",
    grader_version: "1.0.0",
    grader_digest: digest("1"),
    grader_type: "deterministic",
    rubric_digest: digest("2"),
    cases: [
      {
        case_id: "positive-route",
        trials: [1, 2, 3].map((index) => ({
          trial_id: `trial-${index}`,
          passed: arm === "skill-on" || index === 1,
          verified_success: arm === "skill-on" || index === 1,
          metric_value: arm === "skill-on" || index === 1,
          utility: arm === "skill-on" || index === 1 ? 1 : 0,
          duration_ms: arm === "skill-on" ? 10 : 12,
          retries: 0,
          rework_cycles: 0,
          tool_calls: 1,
        })),
      },
      {
        case_id: "pressure-route",
        trials: [1, 2, 3].map((index) => ({
          trial_id: `trial-${index}`,
          passed: arm === "skill-on" && index !== 3,
          verified_success: arm === "skill-on" && index !== 3,
          metric_value: arm === "skill-on" && index !== 3,
          utility: arm === "skill-on" && index !== 3 ? 1 : 0,
          duration_ms: arm === "skill-on" ? 14 : 18,
          retries: arm === "skill-on" ? 0 : 1,
          rework_cycles: 0,
          tool_calls: arm === "skill-on" ? 1 : 2,
        })),
      },
    ],
    ...overrides,
  };
}

async function runSkillEvaluation(
  baseline: Record<string, unknown>,
  forward: Record<string, unknown>,
) {
  const directory = await mkdtemp(join(tmpdir(), "pragman-skill-evals-"));
  const baselinePath = join(directory, "baseline.json");
  const forwardPath = join(directory, "forward.json");
  const evidencePath = join(directory, "evidence.json");
  await writeFile(baselinePath, JSON.stringify(baseline));
  await writeFile(forwardPath, JSON.stringify(forward));
  const result = spawnSync(process.execPath, [
    runner,
    "--mode",
    "skill-eval",
    baselinePath,
    "--observed",
    forwardPath,
    "--output",
    evidencePath,
  ], { encoding: "utf8" });
  const evidence = result.status === 0 ? JSON.parse(await readFile(evidencePath, "utf8")) : null;
  return { result, evidence };
}

async function runBehavioralSkillEvaluation(
  baseline: Record<string, unknown>,
  forward: Record<string, unknown>,
) {
  const directory = await mkdtemp(join(tmpdir(), "pragman-behavioral-skill-evals-"));
  const baselinePath = join(directory, "baseline.json");
  const forwardPath = join(directory, "forward.json");
  const evidencePath = join(directory, "evidence.json");
  await writeFile(baselinePath, JSON.stringify(baseline));
  await writeFile(forwardPath, JSON.stringify(forward));
  const result = spawnSync(process.execPath, [
    runner,
    "--mode",
    "behavioral-skill",
    baselinePath,
    "--observed",
    forwardPath,
    "--output",
    evidencePath,
  ], { encoding: "utf8" });
  const evidence = result.status === 0 || result.status === 1
    ? JSON.parse(await readFile(evidencePath, "utf8"))
    : null;
  return { result, evidence };
}

function behavioralSkillPair() {
  const baseline = {
    schema_version: 1,
    skill_id: "pragman-example",
    evaluation_kind: "behavioral",
    arm: "skill-off",
    privacy: "sanitized",
    scenarios: [
      {
        scenario_id: "positive-control",
        case_type: "trigger",
        prompt: "Diagnose why repeated agent work is slow and unreliable.",
        expected_trigger: true,
        observed_failures: ["Skipped diagnosis"],
        expected_invariants: [
          { path: "triggered", equals: true },
          { path: "checks.diagnosed_before_tuning", equals: true },
        ],
      },
      {
        scenario_id: "negative-control",
        case_type: "non-trigger",
        prompt: "Calculate 2 + 2 without changing workflow configuration.",
        expected_trigger: false,
        observed_failures: ["Over-triggered on an unrelated bounded request"],
        expected_invariants: [
          { path: "triggered", equals: false },
          { path: "checks.left_request_unrouted", equals: true },
        ],
      },
    ],
  };
  const forward = {
    schema_version: 1,
    skill_id: "pragman-example",
    evaluation_kind: "behavioral",
    arm: "skill-on",
    privacy: "sanitized",
    observation_source: "curated-structured-observation",
    scenarios: [
      {
        scenario_id: "positive-control",
        observation: { triggered: true, checks: { diagnosed_before_tuning: true } },
      },
      {
        scenario_id: "negative-control",
        observation: { triggered: false, checks: { left_request_unrouted: true } },
      },
    ],
  };
  return { baseline, forward };
}

test("behavioral-skill mode derives positive and negative trigger evidence from structured observations", async () => {
  const { baseline, forward } = behavioralSkillPair();
  const { result, evidence } = await runBehavioralSkillEvaluation(baseline, forward);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(evidence.summary, {
    scenarios: 2,
    trigger_cases: 1,
    non_trigger_cases: 1,
    evaluated_invariants: 4,
    passed_invariants: 4,
    failed_invariants: 0,
  });
  assert.equal(evidence.status, "PASS");
  assert.equal(evidence.results.every((item: { passed: boolean }) => item.passed), true);
  assert.equal(JSON.stringify(evidence).includes("Diagnose why"), false);
  assert.equal(JSON.stringify(evidence).includes("diagnosed_before_tuning"), false);
});

test("behavioral-skill mode fails a tampered observation and requires a non-trigger control", async () => {
  const { baseline, forward } = behavioralSkillPair();
  const tampered = structuredClone(forward);
  (tampered.scenarios[0] as { observation: { triggered: boolean } }).observation.triggered = false;
  const failed = await runBehavioralSkillEvaluation(baseline, tampered);
  assert.equal(failed.result.status, 1, failed.result.stderr);
  assert.equal(failed.evidence.status, "FAIL");
  assert.equal(failed.evidence.summary.failed_invariants, 1);

  const missingControl = structuredClone(baseline);
  missingControl.scenarios = [missingControl.scenarios[0]];
  const rejected = await runBehavioralSkillEvaluation(missingControl, forward);
  assert.equal(rejected.result.status, 2);
  assert.match(rejected.result.stderr, /non-trigger/i);

  const contentBearingTrigger = structuredClone(forward);
  (contentBearingTrigger.scenarios[0] as { observation: { triggered: unknown } }).observation.triggered = "raw-private-text";
  const unsafe = await runBehavioralSkillEvaluation(baseline, contentBearingTrigger);
  assert.equal(unsafe.result.status, 2);
  assert.match(unsafe.result.stderr, /trigger/i);
});

test("eval runner validates scenarios and records baseline and forward-test evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman-evals-"));
  const scenarioPath = join(directory, "scenario.json");
  const observedPath = join(directory, "observed.json");
  const evidencePath = join(directory, "evidence.json");
  await writeFile(scenarioPath, JSON.stringify({
    schema_version: 1,
    scenarios: [
      {
        id: "baseline-redaction",
        mode: "baseline",
        input: { text: "input-is-not-an-oracle" },
        expected_invariants: [{ path: "result", equals: { status: "safe", counts: [1, 2] } }],
      },
      {
        id: "forward-redaction",
        mode: "forward-test",
        input: { text: "another-input" },
        expected_invariants: [{ path: "result", equals: { status: "future", counts: [3] } }],
      },
    ],
  }));
  await writeFile(observedPath, JSON.stringify({
    "baseline-redaction": { result: { counts: [1, 2], status: "safe" } },
    "forward-redaction": { result: { status: "future", counts: [3] } },
  }));

  const result = spawnSync(process.execPath, [
    runner,
    scenarioPath,
    "--observed",
    observedPath,
    "--output",
    evidencePath,
  ], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.deepEqual(evidence.summary, { total: 2, passed: 2, failed: 0 });
  assert.deepEqual(evidence.results.map((item: { mode: string }) => item.mode), [
    "baseline",
    "forward-test",
  ]);
  assert.equal(evidence.results.every((item: { passed: boolean }) => item.passed), true);
  assert.equal(JSON.stringify(evidence).includes("counts"), false);
  assert.equal(JSON.stringify(evidence).includes("safe"), false);
});

test("eval runner rejects malformed scenarios without writing evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman-evals-invalid-"));
  const scenarioPath = join(directory, "scenario.json");
  const observedPath = join(directory, "observed.json");
  const evidencePath = join(directory, "evidence.json");
  await writeFile(scenarioPath, JSON.stringify({ schema_version: 1, scenarios: [{ id: "bad" }] }));
  await writeFile(observedPath, "{}");

  const result = spawnSync(process.execPath, [runner, scenarioPath, "--observed", observedPath, "--output", evidencePath], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid scenario/i);
});

test("eval runner requires both modes and never persists secret-bearing observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman-evals-secret-"));
  const scenarioPath = join(directory, "scenario.json");
  const observedPath = join(directory, "observed.json");
  const evidencePath = join(directory, "evidence.json");
  const secret = "sk-proj-super-secret-observed-value";
  await writeFile(scenarioPath, JSON.stringify({
    schema_version: 1,
    scenarios: [
      { id: "baseline-secret", mode: "baseline", input: {}, expected_invariants: [{ path: "token", equals: secret }] },
      { id: "forward-secret", mode: "forward-test", input: {}, expected_invariants: [{ path: "token", equals: secret }] },
    ],
  }));
  await writeFile(observedPath, JSON.stringify({
    "baseline-secret": { token: secret },
    "forward-secret": { token: secret },
  }));

  const result = spawnSync(process.execPath, [runner, scenarioPath, "--observed", observedPath, "--output", evidencePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const serializedEvidence = await readFile(evidencePath, "utf8");
  assert.doesNotMatch(serializedEvidence, /sk-proj|super-secret|token/);
  const evidence = JSON.parse(serializedEvidence);
  assert.match(evidence.results[0].invariants[0].expected_digest, /^[a-f0-9]{64}$/);
  assert.match(evidence.results[0].invariants[0].observed_digest, /^[a-f0-9]{64}$/);
});

test("eval runner rejects prototype path segments and never reads inherited properties", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragman-evals-prototype-"));
  const scenarioPath = join(directory, "scenario.json");
  const observedPath = join(directory, "observed.json");
  const evidencePath = join(directory, "evidence.json");
  await writeFile(scenarioPath, JSON.stringify({
    schema_version: 1,
    scenarios: [
      { id: "baseline-prototype", mode: "baseline", input: {}, expected_invariants: [{ path: "constructor.name", equals: "Object" }] },
      { id: "forward-prototype", mode: "forward-test", input: {}, expected_invariants: [{ path: "__proto__.polluted", equals: true }] },
    ],
  }));
  await writeFile(observedPath, JSON.stringify({ "baseline-prototype": {}, "forward-prototype": {} }));

  const rejected = spawnSync(process.execPath, [runner, scenarioPath, "--observed", observedPath, "--output", evidencePath], { encoding: "utf8" });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /forbidden path segment/i);

  await writeFile(scenarioPath, JSON.stringify({
    schema_version: 1,
    scenarios: [
      { id: "baseline-inherited", mode: "baseline", input: {}, expected_invariants: [{ path: "toString.length", equals: 0 }] },
      { id: "forward-inherited", mode: "forward-test", input: {}, expected_invariants: [{ path: "toString.length", equals: 0 }] },
    ],
  }));
  await writeFile(observedPath, JSON.stringify({ "baseline-inherited": {}, "forward-inherited": {} }));

  const inherited = spawnSync(process.execPath, [runner, scenarioPath, "--observed", observedPath, "--output", evidencePath], { encoding: "utf8" });
  assert.equal(inherited.status, 1, inherited.stderr);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.results.every((result: { passed: boolean }) => !result.passed), true);
});

test("skill-eval mode emits versioned content-free paired evidence with complete comparability", async () => {
  const { result, evidence } = await runSkillEvaluation(
    skillEvaluationArm("skill-off"),
    skillEvaluationArm("skill-on"),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(evidence.schema_version, 2);
  assert.equal(evidence.mode, "skill-eval");
  assert.equal(evidence.status, "COMPARABLE");
  assert.equal(evidence.pair_count, 6);
  assert.deepEqual(evidence.trials_per_case, { "positive-route": 3, "pressure-route": 3 });
  assert.deepEqual(evidence.arms, ["skill-off", "skill-on"]);
  for (const field of [
    "eval_corpus_digest", "trial_policy_digest", "skill_digest", "provider_digest",
    "environment_digest", "metric_definition_digest", "grader_digest", "rubric_digest",
    "host", "host_version", "model", "model_version", "harness_version",
  ]) {
    assert.notEqual(evidence.comparison_identity[field], undefined, field);
  }
  assert.equal(evidence.significance, null);
  assert.equal(evidence.significance_reason, "MINIMUM_20_PAIRS_REQUIRED");
  assert.equal(evidence.pairs.length, 6);
  assert.deepEqual(Object.keys(evidence.pairs[0]).sort(), [
    "case_id", "efficiency_delta", "metric_delta", "skill_off", "skill_on", "trial_id", "utility_delta",
  ]);
  assert.deepEqual(Object.keys(evidence.pairs[0].skill_on).sort(), [
    "duration_ms", "metric_value", "passed", "retries", "rework_cycles", "tool_calls", "utility", "verified_success",
  ]);

  const serialized = JSON.stringify(evidence);
  for (const forbidden of ["prompt", "output", "transcript", "secret", "path", "tool_args", "source_alias"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test("skill-eval mode requires 2-6 paired trials and explicit on/off capability arms", async () => {
  const oneTrial = skillEvaluationArm("skill-off", {
    cases: [{ case_id: "too-small", trials: (skillEvaluationArm("skill-off").cases as Array<{ trials: unknown[] }>)[0]!.trials.slice(0, 1) }],
  });
  const invalidTrials = await runSkillEvaluation(oneTrial, skillEvaluationArm("skill-on"));
  assert.equal(invalidTrials.result.status, 2);
  assert.match(invalidTrials.result.stderr, /2-6 trials/i);

  const missingOff = await runSkillEvaluation(
    skillEvaluationArm("skill-on"),
    skillEvaluationArm("skill-on"),
  );
  assert.equal(missingOff.result.status, 2);
  assert.match(missingOff.result.stderr, /skill-off/i);
});

test("skill-eval mode returns structured INCOMPARABLE evidence for identity mismatch", async () => {
  const { result, evidence } = await runSkillEvaluation(
    skillEvaluationArm("skill-off"),
    skillEvaluationArm("skill-on", { environment_digest: digest("9"), model_version: "2026-08-02" }),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(evidence, {
    schema_version: 2,
    mode: "skill-eval",
    status: "INCOMPARABLE",
    reasons: ["ENVIRONMENT_DIGEST_MISMATCH", "MODEL_VERSION_MISMATCH"],
  });
});

test("skill-eval public mode rejects non-deterministic graders and content-bearing fields", async () => {
  const nondeterministic = await runSkillEvaluation(
    skillEvaluationArm("skill-off"),
    skillEvaluationArm("skill-on", { grader_type: "llm-judge" }),
  );
  assert.equal(nondeterministic.result.status, 2);
  assert.match(nondeterministic.result.stderr, /deterministic grader/i);

  const contentBearing = await runSkillEvaluation(
    { ...skillEvaluationArm("skill-off"), prompt: "private work" },
    skillEvaluationArm("skill-on"),
  );
  assert.equal(contentBearing.result.status, 2);
  assert.match(contentBearing.result.stderr, /unknown field/i);
});

test("skill-eval mode rejects secret-shaped bounded identifiers before evidence is written", async () => {
  const source = skillEvaluationArm("skill-off");
  const secretTrial = {
    ...source,
    cases: [{
      case_id: "secret-case",
      trials: source.cases[0]!.trials.map((trial, index) => ({
        ...trial,
        trial_id: index === 0 ? "xoxb-1234567890-abcdefghijkl" : trial.trial_id,
      })),
    }],
  };
  const rejected = await runSkillEvaluation(secretTrial, skillEvaluationArm("skill-on"));
  assert.equal(rejected.result.status, 2);
  assert.match(rejected.result.stderr, /invalid.*trial/i);
});

test("skill-eval derives utility and pass from the bundled metric and rejects tampered claims", async () => {
  const source = skillEvaluationArm("skill-on");
  const tampered = {
    ...source,
    cases: source.cases.map((evaluationCase, caseIndex) => ({
      ...evaluationCase,
      trials: evaluationCase.trials.map((trial, trialIndex) => caseIndex === 0 && trialIndex === 0
        ? { ...trial, utility: 0, passed: false }
        : trial),
    })),
  };
  const rejected = await runSkillEvaluation(skillEvaluationArm("skill-off"), tampered);
  assert.equal(rejected.result.status, 2);
  assert.match(rejected.result.stderr, /metric.*outcome|utility|pass/i);
});

test("skill-eval rejects unregistered metric digests and metric identity tampering", async () => {
  const unregistered = await runSkillEvaluation(
    skillEvaluationArm("skill-off"),
    skillEvaluationArm("skill-on", { metric_definition_digest: digest("f") }),
  );
  assert.equal(unregistered.result.status, 2);
  assert.match(unregistered.result.stderr, /metric registration/i);

  const renamed = await runSkillEvaluation(
    skillEvaluationArm("skill-off"),
    skillEvaluationArm("skill-on", { metric_id: "renamed-task-success" }),
  );
  assert.equal(renamed.result.status, 2);
  assert.match(renamed.result.stderr, /metric registration/i);
});

test("the packaged deterministic eval suite includes its public fixtures", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.files.includes("evals/fixtures/"), true);
  assert.match(packageJson.scripts.evals, /--mode skill-eval/);
});

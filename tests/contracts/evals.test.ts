import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runner = new URL("../../scripts/run-evals.mjs", import.meta.url).pathname;

const digest = (character: string) => character.repeat(64);

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
    metric_definition_digest: digest("f"),
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

test("the packaged deterministic eval suite includes its public fixtures", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.files.includes("evals/fixtures/"), true);
  assert.match(packageJson.scripts.evals, /--mode skill-eval/);
});

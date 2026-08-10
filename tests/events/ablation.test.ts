import assert from "node:assert/strict";
import { test } from "node:test";
import { compareAblation, type AblationTrial } from "../../packages/events/src/index.ts";

const digest = (character: string) => character.repeat(64);
function trial(arm: "skill-on" | "skill-off", index: number, overrides: Partial<AblationTrial> = {}): AblationTrial {
  return {
    arm, eval_id: "eval-one", eval_corpus_digest: digest("a"), trial_policy_digest: digest("b"), case_id: `case-${index}`,
    trial_id: `trial-${index}`, skill_digest: digest("c"), provider: "pragman:review", provider_digest: digest("d"),
    host: "codex", host_version: "1", model: "gpt-5", model_version: "1", harness_version: "1",
    metric_id: "quality", metric_definition_digest: digest("e"), grader_id: "grader", grader_version: "1",
    rubric_digest: digest("f"), raw_value: arm === "skill-on" ? 8 : 6, utility: arm === "skill-on" ? 0.8 : 0.6,
    passed: arm === "skill-on", verified_success: arm === "skill-on", duration_ms: arm === "skill-on" ? 90 : 100,
    retries: 0, rework_cycles: 0, tool_calls: arm === "skill-on" ? 2 : 3, ...overrides,
  };
}

test("strict paired comparison reports raw, utility, success, and efficiency deltas", () => {
  const result = compareAblation([trial("skill-off", 2), trial("skill-on", 1), trial("skill-off", 1), trial("skill-on", 2)]);
  assert.equal(result.status, "COMPARABLE");
  if (result.status !== "COMPARABLE") return;
  assert.equal(result.pair_count, 2);
  assert.equal(result.raw_metric_delta, 2);
  assert.equal(result.utility_lift, 0.2);
  assert.equal(result.verified_success_lift, 1);
  assert.deepEqual(result.efficiency_delta, { duration_ms: -10, retries: 0, rework_cycles: 0, tool_calls: -1 });
  assert.equal(result.significance, null);
  assert.deepEqual(result.pairs.map((pair) => pair.pair_id), ["case-1/trial-1", "case-2/trial-2"]);
});

test("returns structured incomparable reasons for missing or changed pairing dimensions", () => {
  assert.deepEqual(compareAblation([trial("skill-on", 1)]), { status: "INCOMPARABLE", reasons: ["MISSING_SKILL_OFF_ARM"] });
  const fields: Array<[keyof AblationTrial, unknown, string]> = [
    ["eval_corpus_digest", digest("9"), "EVAL_CORPUS_DIGEST_MISMATCH"],
    ["trial_policy_digest", digest("9"), "TRIAL_POLICY_DIGEST_MISMATCH"],
    ["skill_digest", digest("9"), "SKILL_DIGEST_MISMATCH"],
    ["provider_digest", digest("9"), "PROVIDER_DIGEST_MISMATCH"],
    ["host_version", "2", "HOST_VERSION_MISMATCH"], ["model_version", "2", "MODEL_VERSION_MISMATCH"],
    ["harness_version", "2", "HARNESS_VERSION_MISMATCH"],
    ["metric_definition_digest", digest("9"), "METRIC_DEFINITION_DIGEST_MISMATCH"],
    ["grader_version", "2", "GRADER_VERSION_MISMATCH"], ["rubric_digest", digest("9"), "RUBRIC_DIGEST_MISMATCH"],
  ];
  for (const [field, value, reason] of fields) {
    const result = compareAblation([trial("skill-on", 1), trial("skill-off", 1, { [field]: value })]);
    assert.equal(result.status, "INCOMPARABLE");
    if (result.status === "INCOMPARABLE") assert.equal(result.reasons.includes(reason as never), true, field);
  }
  const unpaired = compareAblation([trial("skill-on", 1), trial("skill-off", 2)]);
  assert.equal(unpaired.status, "INCOMPARABLE");
  if (unpaired.status === "INCOMPARABLE") assert.equal(unpaired.reasons.includes("PAIRED_TRIAL_IDS_MISMATCH"), true);
});

test("fewer than twenty pairs return raw pairs without a significance claim", () => {
  const trials = Array.from({ length: 19 }, (_, index) => [trial("skill-on", index), trial("skill-off", index)]).flat();
  const result = compareAblation(trials);
  assert.equal(result.status, "COMPARABLE");
  if (result.status === "COMPARABLE") {
    assert.equal(result.pairs.length, 19);
    assert.equal(result.significance, null);
    assert.equal(result.significance_reason, "MINIMUM_20_PAIRS_REQUIRED");
  }
});

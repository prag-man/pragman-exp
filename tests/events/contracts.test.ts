import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalJson,
  createEventValidators,
  sha256Digest,
  USER_RATING_GRADER_ID,
  USER_RATING_GRADER_VERSION,
  USER_RATING_RUBRIC,
  USER_RATING_RUBRIC_DIGEST,
  type SkillEvent,
  type SkillMetric,
  type SkillScore,
} from "../../packages/events/src/index.ts";

const schemaDirectory = new URL("../../packages/config/schemas/", import.meta.url);
const metricUrl = new URL("../../evals/metrics/task-success.json", import.meta.url);
const digest = (character: string) => character.repeat(64);

async function loadJson(url: URL) {
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const validMetric: SkillMetric = {
  schema_version: 1,
  metric_id: "task-success",
  version: "1.0.0",
  description: "Whether deterministic verification confirms the task succeeded.",
  value_type: "boolean",
  boolean_values: [
    { value: false, utility: 0 },
    { value: true, utility: 1 },
  ],
  direction: "maximize",
  pass_rule: { operator: "eq", value: true },
  eligible_score_sources: ["deterministic", "user"],
  eligible_verification_codes: ["verified-success"],
  lifecycle_policy: {
    minimum_trials_per_arm: 3,
    minimum_comparable_environments: 2,
    minimum_pass_rate: 0.8,
    regression_tolerance: 0.05,
    material_lift: 0.1,
    non_inferiority_margin: 0.02,
    efficiency_materiality: {
      duration_ms: 100,
      retries: 1,
      rework_cycles: 1,
      tool_calls: 2,
    },
  },
};

const validEvent: SkillEvent = {
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
};

function validScore(metricDefinitionDigest = sha256Digest(validMetric)): SkillScore {
  return {
    schema_version: 1,
    score_id: "01915b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:05:00Z",
    invocation_id: validEvent.invocation_id,
    metric_id: validMetric.metric_id,
    metric_definition_digest: metricDefinitionDigest,
    value: true,
    value_type: "boolean",
    source: "deterministic",
    grader_id: "task-success-grader",
    grader_version: "1.0.0",
    rubric_digest: metricDefinitionDigest,
    evidence_digests: [digest("c")],
    storage_scope: "local",
  };
}

test("personal measurement defaults on independently from disabled telemetry", async () => {
  const [{ default: Ajv2020 }, schema] = await Promise.all([
    import("ajv/dist/2020.js"),
    loadJson(new URL("personal-config.schema.json", schemaDirectory)),
  ]);
  const validate = new Ajv2020({ useDefaults: true }).compile(schema);
  const config = {
    schema_version: 1,
    privacy: { default_sensitivity: "internal" },
    updates: { channel: "stable" },
    output: { format: "human" },
  };

  assert.equal(validate(config), true, JSON.stringify(validate.errors));
  assert.deepEqual(config.telemetry, { enabled: false });
  assert.deepEqual(config.measurement, { local_events: true });
});

test("event contract accepts nullable production expectation and complete comparison identity", () => {
  const validators = createEventValidators([validMetric]);
  assert.deepEqual(validators.event(validEvent), { ok: true, value: validEvent });

  const evaluationEvent = {
    ...validEvent,
    invocation_mode: "eval",
    eval_id: "review-v1",
    case_id: "case-1",
    trial_id: "trial-1",
    ablation_arm: "skill-on",
    trigger_expected: true,
    eval_corpus_digest: digest("d"),
    trial_policy_digest: digest("e"),
  };
  assert.equal(validators.event(evaluationEvent).ok, true);
  assert.equal(validators.event({ ...evaluationEvent, provider_digest: null }).ok, false);
  assert.equal(validators.event({ ...evaluationEvent, model_version: "" }).ok, false);
});

test("persisted records reject arbitrary text, unknown fields, and known secret formats", () => {
  const validators = createEventValidators([validMetric]);
  const secret = `sk-proj-${"A".repeat(24)}`;
  assert.equal(validators.event({ ...validEvent, prompt: "private prompt" }).ok, false);
  assert.equal(validators.event({ ...validEvent, source_aliases: [secret] }).ok, false);

  const score = validScore();
  assert.equal(validators.score({ ...score, feedback: "free-form feedback" }, validMetric).ok, false);
  assert.equal(validators.score({ ...score, grader_id: secret }, validMetric).ok, false);

  const rollup = validRollup();
  assert.equal(validators.rollup({ ...rollup, summary: "free form" }).ok, false);
  assert.equal(validators.rollup({ ...rollup, dimensions: { ...rollup.dimensions, host: secret } }).ok, false);

  const candidate = validCandidate();
  assert.equal(validators.candidate(candidate).ok, true);
  assert.equal(validators.candidate({ ...candidate, transcript: "raw transcript" }).ok, false);
  assert.equal(validators.candidate({ ...candidate, redacted_artifact_alias: secret }).ok, false);

  const approval = validApproval();
  assert.equal(validators.approval(approval).ok, true);
  assert.equal(validators.approval({ ...approval, reason: "free-form reason" }).ok, false);
  assert.equal(validators.approval({ ...approval, candidate_digest: secret }).ok, false);
});

test("event schema rejects legacy vocabulary and requires canonical nullable fields", () => {
  const validators = createEventValidators([validMetric]);
  assert.equal(validators.event({ ...validEvent, event_type: "discovered" }).ok, false);
  assert.equal(validators.event({ ...validEvent, event_type: "failed" }).ok, false);
  assert.equal(validators.event({ ...validEvent, latency_ms: 10 }).ok, false);
  const withoutProviderDigest = { ...validEvent } as Record<string, unknown>;
  delete withoutProviderDigest.provider_digest;
  assert.equal(validators.event(withoutProviderDigest).ok, false);
});

test("event verification passes cannot exceed verification checks", () => {
  const validators = createEventValidators([validMetric]);
  assert.deepEqual(validators.event({
    ...validEvent,
    verification_checks: 0,
    verification_passes: 1,
  }), { ok: false, code: "EVENT_VERIFICATION_COUNT_INVALID" });
});

test("metric schema enforces exactly one domain and bounded category identifiers and ranks", () => {
  const validators = createEventValidators([validMetric]);
  assert.equal(validators.metric(validMetric).ok, true);
  assert.equal(validators.metric({ ...validMetric, number_range: { min: 0, max: 1 } }).ok, false);

  const categoryMetric = {
    ...validMetric,
    metric_id: "review-quality",
    value_type: "category",
    boolean_values: undefined,
    categories: [
      { id: "poor", rank: 0, passing: false, utility: 0 },
      { id: "good", rank: 1, passing: true, utility: 1 },
    ],
    pass_rule: { operator: "eq", value: "good" },
  };
  const withoutUndefined = JSON.parse(JSON.stringify(categoryMetric));
  assert.equal(validators.metric(withoutUndefined).ok, true);
  assert.equal(validators.metric({ ...withoutUndefined, categories: [
    { id: "good", rank: 0, passing: false, utility: 0 },
    { id: "good", rank: 1, passing: true, utility: 1 },
  ] }).ok, false);
  assert.equal(validators.metric({ ...withoutUndefined, categories: [
    { id: "poor", rank: 0, passing: false, utility: 0 },
    { id: "good", rank: 0, passing: true, utility: 1 },
  ] }).ok, false);
  assert.equal(validators.metric({ ...withoutUndefined, categories: [{ id: "free form!", rank: 0, passing: false, utility: 0 }] }).ok, false);
  assert.equal(validators.metric({ ...withoutUndefined, categories: [{ id: "good", rank: 101, passing: true, utility: 1 }] }).ok, false);
});

test("metric contracts cover numeric directions, targets, pass rules, and lifecycle bounds", () => {
  const validators = createEventValidators([validMetric]);
  const numberMetric = {
    ...validMetric,
    metric_id: "duration-efficiency",
    value_type: "number",
    boolean_values: undefined,
    number_range: { min: 0, max: 10 },
    direction: "minimize",
    pass_rule: { operator: "lte", value: 5 },
  };
  const clean = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.equal(validators.metric(clean(numberMetric)).ok, true);
  assert.equal(validators.metric(clean({ ...numberMetric, direction: "maximize", pass_rule: { operator: "gte", value: 5 } })).ok, true);
  assert.equal(validators.metric(clean({ ...numberMetric, direction: "maximize", pass_rule: { operator: "lte", value: 5 } })).ok, false);
  assert.equal(validators.metric(clean({ ...numberMetric, direction: "target", target: 5, pass_rule: { operator: "eq", value: 5 } })).ok, true);
  assert.equal(validators.metric(clean({ ...numberMetric, direction: "target", target_range: { min: 4, max: 6 }, pass_rule: { operator: "between", min: 4, max: 6 } })).ok, true);
  assert.equal(validators.metric(clean({ ...numberMetric, number_range: { min: 1, max: 1 } })).ok, false);
  assert.equal(validators.metric(clean({ ...numberMetric, pass_rule: { operator: "between", value: 5 } })).ok, false);
  assert.equal(validators.metric(clean({ ...numberMetric, lifecycle_policy: { ...validMetric.lifecycle_policy, minimum_trials_per_arm: 1 } })).ok, false);
  const incompletePolicy = { ...validMetric.lifecycle_policy } as Record<string, unknown>;
  delete incompletePolicy.material_lift;
  assert.equal(validators.metric(clean({ ...numberMetric, lifecycle_policy: incompletePolicy })).ok, false);
});

test("score validation enforces definition digest, metric domain, value type, and eligible source", () => {
  const validators = createEventValidators([validMetric]);
  const score = validScore();
  assert.deepEqual(validators.score(score, validMetric), { ok: true, value: score });
  assert.deepEqual(validators.score({ ...score, metric_definition_digest: digest("f") }, validMetric), {
    ok: false,
    code: "METRIC_DIGEST_MISMATCH",
  });
  assert.deepEqual(validators.score({ ...score, metric_id: "different-metric" }, validMetric), {
    ok: false,
    code: "METRIC_ID_MISMATCH",
  });
  assert.deepEqual(validators.score({ ...score, value: "unknown", value_type: "category" }, validMetric), {
    ok: false,
    code: "METRIC_VALUE_TYPE_MISMATCH",
  });
  assert.deepEqual(validators.score({ ...score, source: "llm-judge" }, validMetric), {
    ok: false,
    code: "INELIGIBLE_SCORE_SOURCE",
  });
  assert.deepEqual(validators.score({ ...score, rubric_digest: digest("8") }, validMetric), {
    ok: false,
    code: "DETERMINISTIC_RUBRIC_DIGEST_MISMATCH",
  });

  const unregisteredMetric = { ...validMetric, metric_id: "unregistered-task-success" };
  const unregisteredScore = {
    ...score,
    metric_id: unregisteredMetric.metric_id,
    metric_definition_digest: sha256Digest(unregisteredMetric),
    rubric_digest: sha256Digest(unregisteredMetric),
  };
  assert.deepEqual(validators.score(unregisteredScore, unregisteredMetric), {
    ok: false,
    code: "UNKNOWN_METRIC_DEFINITION",
  });

  const numberMetric = JSON.parse(JSON.stringify({
    ...validMetric,
    metric_id: "bounded-score",
    value_type: "number",
    boolean_values: undefined,
    number_range: { min: 0, max: 1 },
    direction: "maximize",
    pass_rule: { operator: "gte", value: 0.8 },
  })) as SkillMetric;
  const numberScore = {
    ...score,
    metric_id: numberMetric.metric_id,
    metric_definition_digest: sha256Digest(numberMetric),
    rubric_digest: sha256Digest(numberMetric),
    value_type: "number",
    value: 2,
  };
  const numberValidators = createEventValidators([numberMetric]);
  assert.deepEqual(numberValidators.score(numberScore, numberMetric), { ok: false, code: "SCORE_OUTSIDE_METRIC_DOMAIN" });
});

test("user scores require the fixed public user-rating grader and rubric", () => {
  const validators = createEventValidators([validMetric]);
  const rubricDigest = sha256Digest({
    schema_version: 1,
    rubric_id: "user-rating",
    version: "1.0.0",
    method: "explicit-user-rating",
  });
  const userScore = {
    ...validScore(),
    source: "user",
    grader_id: "user-rating",
    grader_version: "1.0.0",
    rubric_digest: rubricDigest,
  };

  assert.equal(USER_RATING_GRADER_ID, "user-rating");
  assert.equal(USER_RATING_GRADER_VERSION, "1.0.0");
  assert.deepEqual(USER_RATING_RUBRIC, {
    schema_version: 1,
    rubric_id: "user-rating",
    version: "1.0.0",
    method: "explicit-user-rating",
  });
  assert.equal(USER_RATING_RUBRIC_DIGEST, rubricDigest);
  assert.equal(validators.score(userScore, validMetric).ok, true);
  assert.deepEqual(validators.score({ ...userScore, grader_id: "custom-user-grader" }, validMetric), {
    ok: false,
    code: "USER_RATING_GRADER_MISMATCH",
  });
  assert.deepEqual(validators.score({ ...userScore, grader_version: "2.0.0" }, validMetric), {
    ok: false,
    code: "USER_RATING_GRADER_MISMATCH",
  });
  assert.deepEqual(validators.score({ ...userScore, rubric_digest: digest("7") }, validMetric), {
    ok: false,
    code: "USER_RATING_RUBRIC_DIGEST_MISMATCH",
  });
});

test("category passing flags and direction utility ordering are semantically consistent", () => {
  const validators = createEventValidators([validMetric]);
  const categoryMetric = (overrides: Record<string, unknown> = {}) => ({
    ...validMetric,
    metric_id: "review-quality",
    value_type: "category",
    boolean_values: undefined,
    categories: [
      { id: "poor", rank: 0, passing: false, utility: 0 },
      { id: "good", rank: 1, passing: true, utility: 1 },
    ],
    direction: "maximize",
    pass_rule: { operator: "eq", value: "good" },
    ...overrides,
  });
  const clean = (value: unknown) => JSON.parse(JSON.stringify(value));

  assert.equal(validators.metric(clean(categoryMetric())).ok, true);
  assert.equal(validators.metric(clean(categoryMetric({
    categories: [
      { id: "poor", rank: 0, passing: true, utility: 0 },
      { id: "good", rank: 1, passing: false, utility: 1 },
    ],
  }))).ok, false);
  assert.equal(validators.metric(clean(categoryMetric({
    pass_rule: { operator: "gte", value: 1 },
    categories: [
      { id: "poor", rank: 0, passing: false, utility: 0 },
      { id: "good", rank: 1, passing: true, utility: 0.5 },
      { id: "excellent", rank: 2, passing: true, utility: 1 },
    ],
  }))).ok, true);
  assert.equal(validators.metric(clean(categoryMetric({
    direction: "minimize",
    pass_rule: { operator: "lte", value: 1 },
    categories: [
      { id: "low", rank: 0, passing: true, utility: 1 },
      { id: "medium", rank: 1, passing: true, utility: 0.5 },
      { id: "high", rank: 2, passing: false, utility: 0 },
    ],
  }))).ok, true);
  assert.equal(validators.metric(clean(categoryMetric({
    categories: [
      { id: "poor", rank: 0, passing: false, utility: 1 },
      { id: "good", rank: 1, passing: true, utility: 0 },
    ],
  }))).ok, false);
  assert.equal(validators.metric(clean(categoryMetric({
    direction: "minimize",
    pass_rule: { operator: "eq", value: "poor" },
    categories: [
      { id: "poor", rank: 0, passing: true, utility: 0 },
      { id: "good", rank: 1, passing: false, utility: 1 },
    ],
  }))).ok, false);
  assert.equal(validators.metric(clean(categoryMetric({
    direction: "target",
    categories: [
      { id: "poor", rank: 0, passing: false, utility: 0.4 },
      { id: "good", rank: 1, passing: true, utility: 1 },
      { id: "excessive", rank: 2, passing: false, utility: 0.2 },
    ],
  }))).ok, true);
  assert.equal(validators.metric(clean(categoryMetric({
    direction: "target",
    categories: [
      { id: "poor", rank: 0, passing: true, utility: 0.4 },
      { id: "good", rank: 1, passing: false, utility: 1 },
      { id: "excessive", rank: 2, passing: false, utility: 0.2 },
    ],
  }))).ok, false);
});

test("boolean utility ordering follows direction and the passing value", () => {
  const validators = createEventValidators([validMetric]);
  const booleanMetric = (overrides: Record<string, unknown> = {}) => ({
    ...validMetric,
    metric_id: "boolean-quality",
    ...overrides,
  });

  assert.equal(validators.metric(booleanMetric()).ok, true);
  assert.equal(validators.metric(booleanMetric({
    boolean_values: [
      { value: false, utility: 1 },
      { value: true, utility: 0 },
    ],
  })).ok, false);
  assert.equal(validators.metric(booleanMetric({
    pass_rule: { operator: "eq", value: false },
  })).ok, false);
  assert.equal(validators.metric(booleanMetric({
    direction: "minimize",
    pass_rule: { operator: "eq", value: false },
    boolean_values: [
      { value: false, utility: 1 },
      { value: true, utility: 0 },
    ],
  })).ok, true);
  assert.equal(validators.metric(booleanMetric({
    direction: "minimize",
    pass_rule: { operator: "eq", value: false },
    boolean_values: [
      { value: false, utility: 0 },
      { value: true, utility: 1 },
    ],
  })).ok, false);
  assert.equal(validators.metric(booleanMetric({
    direction: "target",
    pass_rule: { operator: "eq", value: true },
    boolean_values: [
      { value: false, utility: 0.4 },
      { value: true, utility: 1 },
    ],
  })).ok, true);
  assert.equal(validators.metric(booleanMetric({
    direction: "target",
    pass_rule: { operator: "eq", value: true },
    boolean_values: [
      { value: false, utility: 1 },
      { value: true, utility: 0.4 },
    ],
  })).ok, false);
});

test("rollup periods must have strictly positive duration", () => {
  const validators = createEventValidators([validMetric]);
  const rollup = validRollup();

  assert.deepEqual(validators.rollup({
    ...rollup,
    period_start: "2026-08-12T00:00:00Z",
    period_end: "2026-08-11T00:00:00Z",
  }), { ok: false, code: "ROLLUP_PERIOD_INVALID" });
  assert.deepEqual(validators.rollup({ ...rollup, period_end: rollup.period_start }), {
    ok: false,
    code: "ROLLUP_PERIOD_INVALID",
  });
});

test("rollup verification can follow completed or cancelled execution", () => {
  const validators = createEventValidators([validMetric]);
  const rollup = validRollup();
  assert.equal(validators.rollup({
    ...rollup,
    counts: { ...rollup.counts, completed: 0, cancelled: 1, verified: 1 },
  }).ok, true);
  assert.deepEqual(validators.rollup({
    ...rollup,
    counts: { ...rollup.counts, completed: 0, cancelled: 1, verified: 2 },
    source_record_count: 5,
  }), { ok: false, code: "ROLLUP_COUNT_RELATION_INVALID" });
});

test("rollup cross-field totals reject impossible subsets and utility sums", () => {
  const validators = createEventValidators([validMetric]);
  const rollup = validRollup();

  const invalidCounts = [
    { ...rollup.counts, completed: 2 },
    { ...rollup.counts, completed: 1, cancelled: 1 },
    { ...rollup.counts, verified: 2 },
    { ...rollup.counts, incomplete: 2 },
    { ...rollup.counts, eligible: 4 },
  ];
  for (const counts of invalidCounts) {
    assert.deepEqual(validators.rollup({ ...rollup, counts }), {
      ok: false,
      code: "ROLLUP_COUNT_RELATION_INVALID",
    });
  }
  assert.deepEqual(validators.rollup({
    ...rollup,
    score_aggregate: { ...rollup.score_aggregate, count: 1, pass_count: 2 },
  }), { ok: false, code: "ROLLUP_COUNT_RELATION_INVALID" });
  assert.deepEqual(validators.rollup({
    ...rollup,
    observation_source_counts: { ...rollup.observation_source_counts, router: 4 },
  }), { ok: false, code: "ROLLUP_COUNT_RELATION_INVALID" });
  assert.deepEqual(validators.rollup({
    ...rollup,
    histograms: { ...rollup.histograms, duration_ms: [5] },
  }), { ok: false, code: "ROLLUP_COUNT_RELATION_INVALID" });
  assert.deepEqual(validators.rollup({
    ...rollup,
    sums: { ...rollup.sums, verification_checks: 0, verification_passes: 1 },
  }), { ok: false, code: "ROLLUP_VERIFICATION_COUNT_INVALID" });
  assert.deepEqual(validators.rollup({
    ...rollup,
    score_aggregate: { ...rollup.score_aggregate, count: 1, utility_sum: 1.01 },
  }), { ok: false, code: "ROLLUP_UTILITY_SUM_INVALID" });
});

test("canonical serialization and metric digests are stable across key order", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(sha256Digest({ b: 2, a: 1 }), sha256Digest({ a: 1, b: 2 }));
  assert.equal(sha256Digest({ b: 2, a: 1 }), "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  assert.equal(sha256Digest(validMetric), validScore().metric_definition_digest);
  assert.throws(() => canonicalJson(undefined), TypeError);
  assert.throws(() => canonicalJson(new Date()), TypeError);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), TypeError);
  const polluted = Object.create({ injected: true }) as Record<string, unknown>;
  polluted.safe = true;
  assert.throws(() => canonicalJson(polluted), TypeError);
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
  assert.throws(() => canonicalJson(accessor), TypeError);
});

test("canonical arrays accept frozen data while rejecting getters, holes, and extra indices", () => {
  let getterReads = 0;
  const getterArray = [0];
  Object.defineProperty(getterArray, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return getterReads;
    },
  });
  assert.throws(() => canonicalJson(getterArray), TypeError);
  assert.equal(getterReads, 0);

  assert.equal(canonicalJson(Object.freeze([1, 2])), "[1,2]");
  const nonWritable = [1];
  Object.defineProperty(nonWritable, "0", { configurable: true, enumerable: true, writable: false, value: 1 });
  assert.equal(canonicalJson(nonWritable), "[1]");
  const nonConfigurable = [1];
  Object.defineProperty(nonConfigurable, "0", { configurable: false, enumerable: true, writable: true, value: 1 });
  assert.equal(canonicalJson(nonConfigurable), "[1]");

  const nonEnumerable = [1];
  Object.defineProperty(nonEnumerable, "0", { configurable: true, enumerable: false, writable: true, value: 1 });
  assert.throws(() => canonicalJson(nonEnumerable), TypeError);
  const hole = new Array(1);
  assert.throws(() => canonicalJson(hole), TypeError);
  const extraProperty = [1] as number[] & { extra?: number };
  extraProperty.extra = 2;
  assert.throws(() => canonicalJson(extraProperty), TypeError);

  let inheritedGetterReads = 0;
  const inheritedPrototype = Object.create(Array.prototype) as unknown[];
  Object.defineProperty(inheritedPrototype, "0", {
    configurable: true,
    get() {
      inheritedGetterReads += 1;
      return 1;
    },
  });
  const inheritedIndex = new Array(1);
  Object.setPrototypeOf(inheritedIndex, inheritedPrototype);
  assert.throws(() => canonicalJson(inheritedIndex), TypeError);
  assert.equal(inheritedGetterReads, 0);
});

test("deeply frozen metric definitions remain valid registry inputs", () => {
  const frozenMetric = deepFreeze(JSON.parse(JSON.stringify(validMetric)) as SkillMetric);
  const validators = createEventValidators([frozenMetric]);
  assert.equal(validators.metric(frozenMetric).ok, true);
  assert.equal(sha256Digest(frozenMetric), sha256Digest(validMetric));
});

test("validators never coerce, strip, or mutate input", () => {
  const validators = createEventValidators([validMetric]);
  const invalid = { ...validEvent, duration_ms: "0", arbitrary: true };
  const before = canonicalJson(invalid);
  assert.equal(validators.event(invalid).ok, false);
  assert.equal(canonicalJson(invalid), before);
  assert.equal(invalid.duration_ms, "0");
  assert.equal(invalid.arbitrary, true);
});

test("published task-success metric is complete and digest-valid", async () => {
  const published = await loadJson(metricUrl);
  const validators = createEventValidators([published]);
  assert.equal(validators.metric(published).ok, true);
  assert.equal(validators.score(validScore(sha256Digest(published)), published as SkillMetric).ok, true);
});

function validRollup() {
  return {
    schema_version: 1,
    rollup_id: "daily-2026-08-10-task-success",
    period: "daily",
    period_start: "2026-08-10T00:00:00Z",
    period_end: "2026-08-11T00:00:00Z",
    dimensions: {
      skill_id: validEvent.skill_id,
      skill_version: validEvent.skill_version,
      skill_digest: validEvent.skill_digest,
      skill_type: validEvent.skill_type,
      host: validEvent.host,
      host_version: validEvent.host_version,
      model: validEvent.model,
      model_version: validEvent.model_version,
      harness_version: validEvent.harness_version,
      invocation_mode: validEvent.invocation_mode,
      provider: validEvent.provider,
      provider_digest: validEvent.provider_digest,
      event_cohort: "production",
      eval_corpus_digest: null,
      trial_policy_digest: null,
      metric_id: validMetric.metric_id,
      metric_definition_digest: sha256Digest(validMetric),
      rubric_digest: sha256Digest(validMetric),
      ablation_arm: validEvent.ablation_arm,
    },
    counts: { eligible: 0, invoked: 1, completed: 1, cancelled: 0, verified: 1, incomplete: 0 },
    sums: { duration_ms: 120, tool_calls: 2, retries: 0, rework_cycles: 0, verification_checks: 1, verification_passes: 1 },
    histograms: { duration_ms: [0, 1, 0], tool_calls: [0, 0, 1], retries: [1, 0, 0], rework_cycles: [1, 0, 0] },
    score_aggregate: { count: 1, sum: 1, utility_sum: 1, pass_count: 1, correction_count: 0 },
    observation_source_counts: { router: 0, "host-adapter": 1, cli: 0, "eval-runner": 0, "user-report": 0 },
    source_record_count: 4,
    source_record_digest: digest("9"),
    sealed: false,
    storage_scope: "local",
  } as const;
}

function validCandidate() {
  return {
    schema_version: 1,
    candidate_id: "01925b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:10:00Z",
    skill_id: validEvent.skill_id,
    skill_digest: validEvent.skill_digest,
    corpus_id: "review-corpus",
    source_event_digests: [digest("1")],
    failure_codes: ["verification-failed"],
    redacted_artifact_alias: "review-failure-1",
    redacted_artifact_digest: digest("2"),
    approval_status: "pending",
    storage_scope: "local",
    append_only: true,
  } as const;
}

function validApproval() {
  return {
    schema_version: 1,
    approval_id: "01935b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:15:00Z",
    candidate_id: validCandidate().candidate_id,
    candidate_digest: digest("3"),
    decision: "approved",
    approval_source: "user",
    reviewed_redacted_artifact_digest: validCandidate().redacted_artifact_digest,
    storage_scope: "local",
    append_only: true,
  } as const;
}

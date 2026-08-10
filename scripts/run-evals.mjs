#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function getPath(value, path) {
  let current = value;
  for (const segment of path.split(".")) {
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function safeDigest(value) {
  const serialized = value === undefined
    ? "undefined"
    : JSON.stringify(canonicalize(value));
  return createHash("sha256").update(serialized).digest("hex");
}

function safeAlias(path) {
  return basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "eval-input";
}

function validateDocument(document) {
  if (
    !document ||
    document.schema_version !== 1 ||
    !Array.isArray(document.scenarios) ||
    document.scenarios.length === 0
  ) {
    return "Invalid scenario document: expected schema_version 1 and a non-empty scenarios array";
  }

  const ids = new Set();
  const modes = new Set();
  for (const scenario of document.scenarios) {
    if (
      !scenario ||
      typeof scenario.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.id) ||
      !["baseline", "forward-test"].includes(scenario.mode) ||
      typeof scenario.input !== "object" ||
      scenario.input === null ||
      !Array.isArray(scenario.expected_invariants) ||
      scenario.expected_invariants.length === 0
    ) {
      return `Invalid scenario: ${scenario?.id ?? "<missing-id>"}`;
    }
    if (ids.has(scenario.id)) {
      return `Invalid scenario: duplicate id ${scenario.id}`;
    }
    ids.add(scenario.id);
    modes.add(scenario.mode);
    for (const invariant of scenario.expected_invariants) {
      if (!invariant || typeof invariant.path !== "string" || !invariant.path || !("equals" in invariant)) {
        return `Invalid scenario invariant: ${scenario.id}`;
      }
      const forbiddenSegment = invariant.path
        .split(".")
        .find((segment) => ["__proto__", "prototype", "constructor"].includes(segment));
      if (forbiddenSegment) {
        return `Invalid scenario invariant: forbidden path segment ${forbiddenSegment}`;
      }
    }
  }
  if (!modes.has("baseline") || !modes.has("forward-test")) {
    return "Invalid scenario document: baseline and forward-test modes are both required";
  }
  return null;
}

function parseArguments(argv) {
  const skillMode = argv[0] === "--mode";
  const mode = skillMode ? argv[1] : "invariants";
  const scenarioPath = skillMode ? argv[2] : argv[0];
  const rest = skillMode ? argv.slice(3) : argv.slice(1);
  const options = { mode, scenarioPath, observedPath: undefined, outputPath: undefined };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value) return null;
    if (flag === "--observed" && !options.observedPath) options.observedPath = value;
    else if (flag === "--output" && !options.outputPath) options.outputPath = value;
    else return null;
  }
  return ["invariants", "skill-eval"].includes(options.mode)
    && options.scenarioPath && options.observedPath && options.outputPath
    ? options
    : null;
}

const SKILL_EVAL_FIELDS = new Set([
  "schema_version", "evaluation_mode", "arm", "skill_type", "eval_id", "eval_corpus_digest",
  "trial_policy_digest", "skill_id", "skill_version", "skill_digest", "provider", "provider_digest",
  "environment_digest", "host", "host_version", "model", "model_version", "harness_version",
  "metric_id", "metric_definition_digest", "grader_id", "grader_version", "grader_digest",
  "grader_type", "rubric_digest", "cases",
]);
const TRIAL_FIELDS = new Set([
  "trial_id", "passed", "verified_success", "metric_value", "utility", "duration_ms", "retries",
  "rework_cycles", "tool_calls",
]);
const DIGEST_FIELDS = [
  "eval_corpus_digest", "trial_policy_digest", "skill_digest", "provider_digest", "environment_digest",
  "metric_definition_digest", "grader_digest", "rubric_digest",
];
const SAFE_ID = /^[a-z0-9]+(?:[a-z0-9:.-]*[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const KNOWN_SECRET = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isBoundedId(value, maximum = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && SAFE_ID.test(value) && !KNOWN_SECRET.test(value);
}

function isCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateSkillTrial(trial, documentLabel, caseId) {
  if (!isPlainObject(trial)) return `Invalid ${documentLabel} trial in ${caseId}`;
  const unknown = Object.keys(trial).find((field) => !TRIAL_FIELDS.has(field));
  if (unknown) return `Invalid ${documentLabel} trial: unknown field ${unknown}`;
  if (!isBoundedId(trial.trial_id)
    || typeof trial.passed !== "boolean"
    || typeof trial.verified_success !== "boolean"
    || !(typeof trial.metric_value === "boolean"
      || (typeof trial.metric_value === "number" && Number.isFinite(trial.metric_value))
      || isBoundedId(trial.metric_value, 64))
    || typeof trial.utility !== "number" || !Number.isFinite(trial.utility) || trial.utility < 0 || trial.utility > 1
    || !["duration_ms", "retries", "rework_cycles", "tool_calls"].every((field) => isCounter(trial[field]))) {
    return `Invalid ${documentLabel} trial in ${caseId}`;
  }
  return null;
}

function validateSkillEvaluationArm(document, documentLabel) {
  if (!isPlainObject(document)) return `Invalid ${documentLabel} skill evaluation document`;
  const unknown = Object.keys(document).find((field) => !SKILL_EVAL_FIELDS.has(field));
  if (unknown) return `Invalid ${documentLabel} skill evaluation: unknown field ${unknown}`;
  if (document.schema_version !== 1 || document.evaluation_mode !== "skill-eval") {
    return `Invalid ${documentLabel} skill evaluation version`;
  }
  if (!["skill-on", "skill-off"].includes(document.arm)
    || !["capability", "preference"].includes(document.skill_type)) {
    return `Invalid ${documentLabel} skill evaluation arm`;
  }
  for (const field of DIGEST_FIELDS) {
    if (typeof document[field] !== "string" || !SHA256.test(document[field])) {
      return `Invalid ${documentLabel} skill evaluation digest: ${field}`;
    }
  }
  for (const field of [
    "eval_id", "skill_id", "skill_version", "provider", "host", "host_version", "model", "model_version",
    "harness_version", "metric_id", "grader_id", "grader_version",
  ]) {
    if (!isBoundedId(document[field])) return `Invalid ${documentLabel} skill evaluation identity: ${field}`;
  }
  if (document.grader_type !== "deterministic") {
    return `Invalid ${documentLabel} skill evaluation: public fixtures require a deterministic grader`;
  }
  if (!Array.isArray(document.cases) || document.cases.length === 0 || document.cases.length > 64) {
    return `Invalid ${documentLabel} skill evaluation cases`;
  }
  const caseIds = new Set();
  for (const evaluationCase of document.cases) {
    if (!isPlainObject(evaluationCase)) return `Invalid ${documentLabel} skill evaluation case`;
    const unknownCaseField = Object.keys(evaluationCase).find((field) => !["case_id", "trials"].includes(field));
    if (unknownCaseField) return `Invalid ${documentLabel} case: unknown field ${unknownCaseField}`;
    if (!isBoundedId(evaluationCase.case_id) || caseIds.has(evaluationCase.case_id)) {
      return `Invalid ${documentLabel} skill evaluation case identity`;
    }
    caseIds.add(evaluationCase.case_id);
    if (!Array.isArray(evaluationCase.trials)
      || evaluationCase.trials.length < 2 || evaluationCase.trials.length > 6) {
      return `Invalid ${documentLabel} skill evaluation: each case requires 2-6 trials`;
    }
    const trialIds = new Set();
    for (const trial of evaluationCase.trials) {
      const trialError = validateSkillTrial(trial, documentLabel, evaluationCase.case_id);
      if (trialError) return trialError;
      if (trialIds.has(trial.trial_id)) return `Invalid ${documentLabel} skill evaluation: duplicate trial identity`;
      trialIds.add(trial.trial_id);
    }
  }
  return null;
}

const COMPARABLE_SKILL_FIELDS = [
  ["eval_id", "EVAL_ID_MISMATCH"],
  ["eval_corpus_digest", "EVAL_CORPUS_DIGEST_MISMATCH"],
  ["trial_policy_digest", "TRIAL_POLICY_DIGEST_MISMATCH"],
  ["skill_type", "SKILL_TYPE_MISMATCH"],
  ["skill_id", "SKILL_ID_MISMATCH"],
  ["skill_version", "SKILL_VERSION_MISMATCH"],
  ["skill_digest", "SKILL_DIGEST_MISMATCH"],
  ["provider", "PROVIDER_MISMATCH"],
  ["provider_digest", "PROVIDER_DIGEST_MISMATCH"],
  ["environment_digest", "ENVIRONMENT_DIGEST_MISMATCH"],
  ["host", "HOST_MISMATCH"],
  ["host_version", "HOST_VERSION_MISMATCH"],
  ["model", "MODEL_MISMATCH"],
  ["model_version", "MODEL_VERSION_MISMATCH"],
  ["harness_version", "HARNESS_VERSION_MISMATCH"],
  ["metric_id", "METRIC_ID_MISMATCH"],
  ["metric_definition_digest", "METRIC_DEFINITION_DIGEST_MISMATCH"],
  ["grader_id", "GRADER_ID_MISMATCH"],
  ["grader_version", "GRADER_VERSION_MISMATCH"],
  ["grader_digest", "GRADER_DIGEST_MISMATCH"],
  ["rubric_digest", "RUBRIC_DIGEST_MISMATCH"],
];

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function stableNumber(value) {
  return Number(value.toPrecision(15));
}

function numericMetric(value) {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  return null;
}

function publicTrial(trial) {
  return {
    passed: trial.passed,
    verified_success: trial.verified_success,
    metric_value: trial.metric_value,
    utility: trial.utility,
    duration_ms: trial.duration_ms,
    retries: trial.retries,
    rework_cycles: trial.rework_cycles,
    tool_calls: trial.tool_calls,
  };
}

function buildSkillEvaluationEvidence(first, second) {
  if (first.arm === second.arm) {
    throw new Error(`Capability skill evaluation requires explicit skill-off and skill-on arms`);
  }
  const off = first.arm === "skill-off" ? first : second;
  const on = first.arm === "skill-on" ? first : second;
  const reasons = COMPARABLE_SKILL_FIELDS
    .filter(([field]) => off[field] !== on[field])
    .map(([, reason]) => reason);
  const offCases = new Map(off.cases.map((evaluationCase) => [evaluationCase.case_id, evaluationCase]));
  const onCases = new Map(on.cases.map((evaluationCase) => [evaluationCase.case_id, evaluationCase]));
  const caseIds = [...new Set([...offCases.keys(), ...onCases.keys()])].sort();
  if (offCases.size !== onCases.size || caseIds.some((caseId) => !offCases.has(caseId) || !onCases.has(caseId))) {
    reasons.push("CASE_IDS_MISMATCH");
  } else {
    for (const caseId of caseIds) {
      const offTrialIds = offCases.get(caseId).trials.map((trial) => trial.trial_id).sort();
      const onTrialIds = onCases.get(caseId).trials.map((trial) => trial.trial_id).sort();
      if (!isDeepStrictEqual(offTrialIds, onTrialIds)) reasons.push("PAIRED_TRIAL_IDS_MISMATCH");
    }
  }
  if (reasons.length > 0) {
    return { schema_version: 2, mode: "skill-eval", status: "INCOMPARABLE", reasons: [...new Set(reasons)].sort() };
  }

  const pairs = caseIds.flatMap((caseId) => {
    const offTrials = new Map(offCases.get(caseId).trials.map((trial) => [trial.trial_id, trial]));
    return [...onCases.get(caseId).trials].sort((left, right) => left.trial_id.localeCompare(right.trial_id)).map((onTrial) => {
      const offTrial = offTrials.get(onTrial.trial_id);
      const onMetric = numericMetric(onTrial.metric_value);
      const offMetric = numericMetric(offTrial.metric_value);
      return {
        case_id: caseId,
        trial_id: onTrial.trial_id,
        skill_on: publicTrial(onTrial),
        skill_off: publicTrial(offTrial),
        metric_delta: onMetric === null || offMetric === null ? null : stableNumber(onMetric - offMetric),
        utility_delta: stableNumber(onTrial.utility - offTrial.utility),
        efficiency_delta: {
          duration_ms: onTrial.duration_ms - offTrial.duration_ms,
          retries: onTrial.retries - offTrial.retries,
          rework_cycles: onTrial.rework_cycles - offTrial.rework_cycles,
          tool_calls: onTrial.tool_calls - offTrial.tool_calls,
        },
      };
    });
  });
  const averageDelta = (field) => stableNumber(mean(pairs.map((pair) => pair.efficiency_delta[field])));
  const utilityDeltas = pairs.map((pair) => pair.utility_delta);
  let significance = null;
  if (pairs.length >= 20) {
    const average = mean(utilityDeltas);
    const variance = utilityDeltas.reduce((total, value) => total + (value - average) ** 2, 0) / (utilityDeltas.length - 1);
    const margin = 1.96 * Math.sqrt(variance / utilityDeltas.length);
    significance = {
      confidence_level: 0.95,
      lower: stableNumber(average - margin),
      upper: stableNumber(average + margin),
      significant: average - margin > 0 || average + margin < 0,
    };
  }
  return {
    schema_version: 2,
    mode: "skill-eval",
    status: "COMPARABLE",
    comparison_identity: Object.fromEntries(COMPARABLE_SKILL_FIELDS.map(([field]) => [field, on[field]])),
    arms: ["skill-off", "skill-on"],
    trials_per_case: Object.fromEntries(caseIds.map((caseId) => [caseId, onCases.get(caseId).trials.length])),
    pair_count: pairs.length,
    skill_on_pass_rate: stableNumber(mean(pairs.map((pair) => Number(pair.skill_on.passed)))),
    skill_off_pass_rate: stableNumber(mean(pairs.map((pair) => Number(pair.skill_off.passed)))),
    utility_lift: stableNumber(mean(utilityDeltas)),
    verified_success_lift: stableNumber(mean(pairs.map((pair) => Number(pair.skill_on.verified_success) - Number(pair.skill_off.verified_success)))),
    efficiency_delta: {
      duration_ms: averageDelta("duration_ms"), retries: averageDelta("retries"),
      rework_cycles: averageDelta("rework_cycles"), tool_calls: averageDelta("tool_calls"),
    },
    pairs,
    significance,
    significance_reason: pairs.length < 20 ? "MINIMUM_20_PAIRS_REQUIRED" : null,
  };
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(argv) {
  const options = parseArguments(argv);
  if (!options) {
    fail("Usage: run-evals.mjs [--mode skill-eval] <scenario.json> --observed <observed.json> --output <evidence.json>");
    return;
  }

  let document;
  let observed;
  try {
    document = await readJson(options.scenarioPath, "scenario document");
    observed = await readJson(options.observedPath, "observed results");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  if (options.mode === "skill-eval") {
    const scenarioError = validateSkillEvaluationArm(document, "baseline");
    const observedError = validateSkillEvaluationArm(observed, "forward");
    if (scenarioError || observedError) {
      fail(scenarioError ?? observedError);
      return;
    }
    let evidence;
    try {
      evidence = buildSkillEvaluationEvidence(document, observed);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (options.outputPath !== "-") {
      await writeFile(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "w" });
    }
    process.stdout.write(`${JSON.stringify({ status: evidence.status, pair_count: evidence.pair_count ?? 0 })}\n`);
    return;
  }

  const validationError = validateDocument(document);
  if (validationError) {
    fail(validationError);
    return;
  }
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
    fail("Invalid observed results: expected an object keyed by scenario ID");
    return;
  }
  const scenarioIds = document.scenarios.map((scenario) => scenario.id).sort();
  const observedIds = Object.keys(observed).sort();
  if (!isDeepStrictEqual(observedIds, scenarioIds)) {
    fail("Invalid observed results: keys must exactly match scenario IDs");
    return;
  }

  const results = document.scenarios.map((scenario) => {
    const observation = observed[scenario.id];
    const invariants = scenario.expected_invariants.map((invariant, invariantIndex) => {
      const actual = getPath(observation, invariant.path);
      return {
        invariant_index: invariantIndex,
        passed: isDeepStrictEqual(actual, invariant.equals),
        expected_digest: safeDigest(invariant.equals),
        observed_digest: safeDigest(actual),
      };
    });
    return {
      scenario_id: scenario.id,
      mode: scenario.mode,
      passed: invariants.every((invariant) => invariant.passed),
      invariants,
    };
  });
  const passed = results.filter((result) => result.passed).length;
  const evidence = {
    schema_version: 1,
    source_alias: safeAlias(options.scenarioPath),
    observed_source_alias: safeAlias(options.observedPath),
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
  };
  await writeFile(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "w" });
  process.stdout.write(`${JSON.stringify(evidence.summary)}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

await main(process.argv.slice(2));

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const SAFE_SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_SCENARIO_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const CONTENT_KEYS = /^(?:prompt|output|transcript|secret|token|credential|raw_path|source_body|tool_args)$/i;
const KNOWN_SECRET = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
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

function digest(value) {
  const serialized = value === undefined ? "undefined" : JSON.stringify(canonicalize(value));
  return createHash("sha256").update(serialized).digest("hex");
}

function getPath(value, path) {
  let current = value;
  for (const segment of path.split(".")) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function hasUnsafeObservation(value, depth = 0) {
  if (depth > 8) return true;
  if (typeof value === "string") return value.length > 256 || KNOWN_SECRET.test(value);
  if (Array.isArray(value)) return value.length > 32 || value.some((child) => hasUnsafeObservation(child, depth + 1));
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 64 || entries.some(([key, child]) => CONTENT_KEYS.test(key)
    || FORBIDDEN_PATH_SEGMENTS.has(key)
    || hasUnsafeObservation(child, depth + 1));
}

function validateEnvelope(document, arm) {
  const allowed = arm === "skill-off"
    ? new Set(["schema_version", "skill_id", "evaluation_kind", "arm", "privacy", "scenarios"])
    : new Set(["schema_version", "skill_id", "evaluation_kind", "arm", "privacy", "observation_source", "scenarios"]);
  if (!isPlainObject(document)) return "document must be an object";
  const unknown = Object.keys(document).find((field) => !allowed.has(field));
  if (unknown) return `unknown ${arm} field ${unknown}`;
  if (document.schema_version !== 1 || document.evaluation_kind !== "behavioral"
    || document.arm !== arm || document.privacy !== "sanitized"
    || typeof document.skill_id !== "string" || !SAFE_SKILL_ID.test(document.skill_id)) {
    return `invalid ${arm} envelope`;
  }
  if (arm === "skill-on" && document.observation_source !== "curated-structured-observation") {
    return "skill-on observation_source must disclose curated structured observations";
  }
  if (!Array.isArray(document.scenarios) || document.scenarios.length < 2 || document.scenarios.length > 12) {
    return `${arm} trigger and non-trigger controls require 2-12 scenarios`;
  }
  return null;
}

function validateInvariant(invariant) {
  if (!isPlainObject(invariant) || Object.keys(invariant).some((field) => !["path", "equals"].includes(field))
    || typeof invariant.path !== "string" || !invariant.path || invariant.path.length > 128
    || !Object.hasOwn(invariant, "equals")) return "invalid invariant";
  const segments = invariant.path.split(".");
  if (segments.some((segment) => !/^[a-z][a-z0-9_]*$/.test(segment) || FORBIDDEN_PATH_SEGMENTS.has(segment))) {
    return "invalid invariant path";
  }
  if (hasUnsafeObservation(invariant.equals)) return "unsafe invariant expectation";
  return null;
}

export function validateBehavioralSkillPair(baseline, forward, expectedSkillId) {
  const baselineEnvelope = validateEnvelope(baseline, "skill-off");
  if (baselineEnvelope) return baselineEnvelope;
  const forwardEnvelope = validateEnvelope(forward, "skill-on");
  if (forwardEnvelope) return forwardEnvelope;
  if (baseline.skill_id !== forward.skill_id || (expectedSkillId && baseline.skill_id !== expectedSkillId)) {
    return "skill identities do not match";
  }

  const baselineIds = new Set();
  const caseTypes = new Set();
  for (const scenario of baseline.scenarios) {
    if (!isPlainObject(scenario)) return "invalid skill-off scenario";
    const allowed = new Set([
      "scenario_id", "case_type", "prompt", "expected_trigger", "observed_failures", "expected_invariants",
    ]);
    const unknown = Object.keys(scenario).find((field) => !allowed.has(field));
    if (unknown) return `unknown skill-off scenario field ${unknown}`;
    if (typeof scenario.scenario_id !== "string" || !SAFE_SCENARIO_ID.test(scenario.scenario_id)
      || baselineIds.has(scenario.scenario_id)) return "invalid or duplicate skill-off scenario identity";
    baselineIds.add(scenario.scenario_id);
    if (!['trigger', 'non-trigger'].includes(scenario.case_type)
      || scenario.expected_trigger !== (scenario.case_type === "trigger")) return `invalid trigger expectation in ${scenario.scenario_id}`;
    caseTypes.add(scenario.case_type);
    if (typeof scenario.prompt !== "string" || !scenario.prompt.trim() || scenario.prompt.length > 500
      || KNOWN_SECRET.test(scenario.prompt)) return `invalid prompt in ${scenario.scenario_id}`;
    if (!Array.isArray(scenario.observed_failures) || scenario.observed_failures.length === 0
      || scenario.observed_failures.length > 8
      || scenario.observed_failures.some((failure) => typeof failure !== "string" || !failure.trim() || failure.length > 200 || KNOWN_SECRET.test(failure))) {
      return `invalid baseline failures in ${scenario.scenario_id}`;
    }
    if (!Array.isArray(scenario.expected_invariants) || scenario.expected_invariants.length < 2
      || scenario.expected_invariants.length > 12) return `invalid invariants in ${scenario.scenario_id}`;
    const paths = new Set();
    for (const invariant of scenario.expected_invariants) {
      const invariantError = validateInvariant(invariant);
      if (invariantError || paths.has(invariant.path)) return `${invariantError ?? "duplicate invariant path"} in ${scenario.scenario_id}`;
      paths.add(invariant.path);
    }
    if (!scenario.expected_invariants.some((invariant) => invariant.path === "triggered"
      && invariant.equals === scenario.expected_trigger)) return `missing derived trigger invariant in ${scenario.scenario_id}`;
  }
  if (!caseTypes.has("trigger") || !caseTypes.has("non-trigger")) {
    return "behavioral corpus requires both trigger and non-trigger controls";
  }

  const forwardIds = new Set();
  for (const scenario of forward.scenarios) {
    if (!isPlainObject(scenario) || Object.keys(scenario).some((field) => !["scenario_id", "observation"].includes(field))
      || typeof scenario.scenario_id !== "string" || !SAFE_SCENARIO_ID.test(scenario.scenario_id)
      || forwardIds.has(scenario.scenario_id) || !isPlainObject(scenario.observation)
      || typeof scenario.observation.triggered !== "boolean"
      || hasUnsafeObservation(scenario.observation)) return "invalid skill-on structured trigger observation";
    forwardIds.add(scenario.scenario_id);
  }
  if (baselineIds.size !== forwardIds.size
    || [...baselineIds].some((scenarioId) => !forwardIds.has(scenarioId))) return "paired scenario identities do not match";
  return null;
}

export function evaluateBehavioralSkillPair(baseline, forward) {
  const observations = new Map(forward.scenarios.map((scenario) => [scenario.scenario_id, scenario.observation]));
  const results = baseline.scenarios.map((scenario) => {
    const observation = observations.get(scenario.scenario_id);
    const invariants = scenario.expected_invariants.map((invariant, invariantIndex) => {
      const actual = getPath(observation, invariant.path);
      return {
        invariant_index: invariantIndex,
        passed: isDeepStrictEqual(actual, invariant.equals),
        expected_digest: digest(invariant.equals),
        observed_digest: digest(actual),
      };
    });
    return {
      scenario_id: scenario.scenario_id,
      case_type: scenario.case_type,
      expected_trigger: scenario.expected_trigger,
      trigger_actual: observation.triggered,
      passed: invariants.every((invariant) => invariant.passed),
      invariants,
    };
  });
  const evaluatedInvariants = results.reduce((total, result) => total + result.invariants.length, 0);
  const passedInvariants = results.reduce(
    (total, result) => total + result.invariants.filter((invariant) => invariant.passed).length,
    0,
  );
  return {
    schema_version: 2,
    mode: "behavioral-skill",
    skill_id: baseline.skill_id,
    status: passedInvariants === evaluatedInvariants ? "PASS" : "FAIL",
    corpus_digest: digest(baseline),
    observation_digest: digest(forward),
    summary: {
      scenarios: results.length,
      trigger_cases: results.filter((result) => result.case_type === "trigger").length,
      non_trigger_cases: results.filter((result) => result.case_type === "non-trigger").length,
      evaluated_invariants: evaluatedInvariants,
      passed_invariants: passedInvariants,
      failed_invariants: evaluatedInvariants - passedInvariants,
    },
    results,
  };
}

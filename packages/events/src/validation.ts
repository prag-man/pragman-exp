import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import approvalSchema from "../../config/schemas/eval-candidate-approval.schema.json" with { type: "json" };
import candidateSchema from "../../config/schemas/eval-candidate.schema.json" with { type: "json" };
import eventSchema from "../../config/schemas/skill-event.schema.json" with { type: "json" };
import metricSchema from "../../config/schemas/skill-metric.schema.json" with { type: "json" };
import rollupSchema from "../../config/schemas/skill-rollup.schema.json" with { type: "json" };
import scoreSchema from "../../config/schemas/skill-score.schema.json" with { type: "json" };
import { sha256Digest } from "./canonical.ts";
import type {
  EvalCandidate,
  EvalCandidateApproval,
  EventValidators,
  MetricPassRule,
  SkillEvent,
  SkillMetric,
  SkillRollup,
  SkillScore,
  ValidationResult,
} from "./types.ts";
import type { DurableRecordType } from "./paths.ts";

const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
const addFormats = ("default" in formatsModule ? formatsModule.default : formatsModule) as unknown as FormatsPlugin;
addFormats(ajv);

const validateEvent = ajv.compile(eventSchema) as ValidateFunction<SkillEvent>;
const validateMetric = ajv.compile(metricSchema) as ValidateFunction<SkillMetric>;
const validateScore = ajv.compile(scoreSchema) as ValidateFunction<SkillScore>;
const validateRollup = ajv.compile(rollupSchema) as ValidateFunction<SkillRollup>;
const validateCandidate = ajv.compile(candidateSchema) as ValidateFunction<EvalCandidate>;
const validateApproval = ajv.compile(approvalSchema) as ValidateFunction<EvalCandidateApproval>;

export const USER_RATING_GRADER_ID = "user-rating";
export const USER_RATING_GRADER_VERSION = "1.0.0";
export const USER_RATING_RUBRIC = Object.freeze({
  schema_version: 1,
  rubric_id: "user-rating",
  version: USER_RATING_GRADER_VERSION,
  method: "explicit-user-rating",
} as const);
export const USER_RATING_RUBRIC_DIGEST = sha256Digest(USER_RATING_RUBRIC);

function schemaResult<T>(validator: ValidateFunction<T>, value: unknown): ValidationResult<T> {
  return validator(value) ? { ok: true, value } : { ok: false, code: "SCHEMA_INVALID" };
}

function isWithin(value: number, range: { min: number; max: number }): boolean {
  return value >= range.min && value <= range.max;
}

function validNumericRule(rule: MetricPassRule, range: { min: number; max: number }): boolean {
  if (rule.operator === "between") {
    return rule.min <= rule.max && isWithin(rule.min, range) && isWithin(rule.max, range);
  }
  return typeof rule.value === "number" && isWithin(rule.value, range);
}

function eventResult(value: unknown): ValidationResult<SkillEvent> {
  const result = schemaResult(validateEvent, value);
  if (!result.ok) return result;
  return result.value.verification_passes <= result.value.verification_checks
    ? result
    : { ok: false, code: "EVENT_VERIFICATION_COUNT_INVALID" };
}

function hasValidMetricSemantics(metric: SkillMetric): boolean {
  if (metric.value_type === "number") {
    const range = metric.number_range;
    if (!range || !(range.min < range.max) || !validNumericRule(metric.pass_rule, range)) return false;
    if (metric.direction === "target") {
      if (metric.target !== undefined) {
        return isWithin(metric.target, range)
          && metric.pass_rule.operator === "eq"
          && metric.pass_rule.value === metric.target;
      }
      const target = metric.target_range;
      return target !== undefined
        && range.min < target.min
        && target.min < target.max
        && target.max < range.max
        && metric.pass_rule.operator === "between"
        && metric.pass_rule.min === target.min
        && metric.pass_rule.max === target.max;
    }
    return metric.target === undefined
      && metric.target_range === undefined
      && ((metric.direction === "maximize" && metric.pass_rule.operator === "gte")
        || (metric.direction === "minimize" && metric.pass_rule.operator === "lte"));
  }

  if (metric.value_type === "boolean") {
    if (metric.pass_rule.operator !== "eq" || typeof metric.pass_rule.value !== "boolean") return false;
    const falseValue = metric.boolean_values?.find((entry) => entry.value === false);
    const trueValue = metric.boolean_values?.find((entry) => entry.value === true);
    if (!falseValue || !trueValue) return false;
    const passingValue = metric.pass_rule.value ? trueValue : falseValue;
    const failingValue = metric.pass_rule.value ? falseValue : trueValue;
    if (passingValue.utility < failingValue.utility) return false;
    if (metric.direction === "target") return true;
    return metric.direction === "maximize"
      ? falseValue.utility <= trueValue.utility
      : falseValue.utility >= trueValue.utility;
  }

  const categories = metric.categories ?? [];
  const identifiers = new Set(categories.map((category) => category.id));
  const ranks = new Set(categories.map((category) => category.rank));
  if (identifiers.size !== categories.length || ranks.size !== categories.length) return false;

  const ordered = [...categories].sort((left, right) => left.rank - right.rank);
  const utilitiesAreOrdered = metric.direction === "target" || ordered.every((category, index) => {
    const previous = ordered[index - 1];
    if (!previous) return true;
    return metric.direction === "maximize"
      ? previous.utility <= category.utility
      : previous.utility >= category.utility;
  });
  if (!utilitiesAreOrdered) return false;

  const rule = metric.pass_rule;
  const minimumRank = ordered[0]?.rank;
  const maximumRank = ordered.at(-1)?.rank;
  let ruleIsInDomain = false;
  if (rule.operator === "eq") {
    ruleIsInDomain = typeof rule.value === "string"
      ? identifiers.has(rule.value)
      : typeof rule.value === "number" && ranks.has(rule.value);
  } else if (rule.operator === "between") {
    ruleIsInDomain = Number.isInteger(rule.min)
      && Number.isInteger(rule.max)
      && minimumRank !== undefined
      && maximumRank !== undefined
      && minimumRank <= rule.min
      && rule.min <= rule.max
      && rule.max <= maximumRank;
  } else {
    ruleIsInDomain = Number.isInteger(rule.value)
      && minimumRank !== undefined
      && maximumRank !== undefined
      && minimumRank <= rule.value
      && rule.value <= maximumRank;
  }
  if (!ruleIsInDomain) return false;

  const categoryPasses = (category: NonNullable<SkillMetric["categories"]>[number]): boolean => {
    if (rule.operator === "eq") {
      return typeof rule.value === "string" ? category.id === rule.value : category.rank === rule.value;
    }
    if (rule.operator === "gte") return category.rank >= rule.value;
    if (rule.operator === "lte") return category.rank <= rule.value;
    if (rule.operator === "between") return category.rank >= rule.min && category.rank <= rule.max;
    return false;
  };

  return categories.every((category) => category.passing === categoryPasses(category))
    && metric.target === undefined
    && metric.target_range === undefined;
}

function metricResult(value: unknown): ValidationResult<SkillMetric> {
  const result = schemaResult(validateMetric, value);
  if (!result.ok) return result;
  return hasValidMetricSemantics(result.value)
    ? result
    : { ok: false, code: "METRIC_SEMANTICS_INVALID" };
}

function scoreIsInDomain(score: SkillScore, metric: SkillMetric): boolean {
  if (metric.value_type === "boolean") return typeof score.value === "boolean";
  if (metric.value_type === "number") {
    return typeof score.value === "number"
      && metric.number_range !== undefined
      && isWithin(score.value, metric.number_range);
  }
  return typeof score.value === "string"
    && (metric.categories ?? []).some((category) => category.id === score.value);
}

export function validateDurableRecordSchema(
  recordType: DurableRecordType,
  value: unknown,
): ValidationResult<SkillEvent | SkillScore | EvalCandidate | EvalCandidateApproval> {
  if (recordType === "skill-events") return eventResult(value);
  if (recordType === "scores") return schemaResult(validateScore, value);
  if (recordType === "eval-candidates") return schemaResult(validateCandidate, value);
  return schemaResult(validateApproval, value);
}

function rollupResult(value: unknown): ValidationResult<SkillRollup> {
  const result = schemaResult(validateRollup, value);
  if (!result.ok) return result;
  const rollup = result.value;
  if (Date.parse(rollup.period_start) >= Date.parse(rollup.period_end)) {
    return { ok: false, code: "ROLLUP_PERIOD_INVALID" };
  }

  const terminalOrIncomplete = rollup.counts.completed + rollup.counts.cancelled + rollup.counts.incomplete;
  const eventRecordCount = rollup.counts.eligible
    + rollup.counts.invoked
    + rollup.counts.completed
    + rollup.counts.cancelled
    + rollup.counts.verified;
  const scoreRecordCount = rollup.score_aggregate.count + rollup.score_aggregate.correction_count;
  const observationCount = Object.values(rollup.observation_source_counts)
    .reduce((total, count) => total + count, 0);
  const histogramExceedsSources = Object.values(rollup.histograms)
    .some((histogram) => histogram.reduce((total, count) => total + count, 0) > rollup.source_record_count);
  if (terminalOrIncomplete > rollup.counts.invoked
    || rollup.counts.verified > rollup.counts.completed + rollup.counts.cancelled
    || rollup.score_aggregate.pass_count > rollup.score_aggregate.count
    || eventRecordCount + scoreRecordCount > rollup.source_record_count
    || observationCount > rollup.source_record_count
    || histogramExceedsSources) {
    return { ok: false, code: "ROLLUP_COUNT_RELATION_INVALID" };
  }
  if (rollup.sums.verification_passes > rollup.sums.verification_checks) {
    return { ok: false, code: "ROLLUP_VERIFICATION_COUNT_INVALID" };
  }
  if (rollup.score_aggregate.utility_sum > rollup.score_aggregate.count) {
    return { ok: false, code: "ROLLUP_UTILITY_SUM_INVALID" };
  }
  return result;
}

export function createEventValidators(metricDefinitions: readonly unknown[] = []): EventValidators {
  const registry = new Map<string, SkillMetric>();
  for (const definition of metricDefinitions) {
    const result = metricResult(definition);
    if (!result.ok) throw new TypeError(`Invalid metric definition: ${result.code}`);
    registry.set(sha256Digest(result.value), result.value);
  }

  return Object.freeze({
    event(value: unknown) {
      return eventResult(value);
    },
    metric(value: unknown) {
      return metricResult(value);
    },
    score(value: unknown, metric: SkillMetric): ValidationResult<SkillScore> {
      const scoreResult = schemaResult(validateScore, value);
      if (!scoreResult.ok) return scoreResult;
      const metricValidation = metricResult(metric);
      if (!metricValidation.ok) return metricValidation;
      const definitionDigest = sha256Digest(metricValidation.value);
      if (!registry.has(definitionDigest)) return { ok: false, code: "UNKNOWN_METRIC_DEFINITION" };
      if (scoreResult.value.metric_id !== metric.metric_id) return { ok: false, code: "METRIC_ID_MISMATCH" };
      if (scoreResult.value.metric_definition_digest !== definitionDigest) return { ok: false, code: "METRIC_DIGEST_MISMATCH" };
      if (scoreResult.value.value_type !== metric.value_type) return { ok: false, code: "METRIC_VALUE_TYPE_MISMATCH" };
      if (!metric.eligible_score_sources.includes(scoreResult.value.source)) return { ok: false, code: "INELIGIBLE_SCORE_SOURCE" };
      if (!scoreIsInDomain(scoreResult.value, metric)) return { ok: false, code: "SCORE_OUTSIDE_METRIC_DOMAIN" };
      if (scoreResult.value.source === "deterministic" && scoreResult.value.rubric_digest !== definitionDigest) {
        return { ok: false, code: "DETERMINISTIC_RUBRIC_DIGEST_MISMATCH" };
      }
      if (scoreResult.value.source === "user") {
        if (scoreResult.value.grader_id !== USER_RATING_GRADER_ID
          || scoreResult.value.grader_version !== USER_RATING_GRADER_VERSION) {
          return { ok: false, code: "USER_RATING_GRADER_MISMATCH" };
        }
        if (scoreResult.value.rubric_digest !== USER_RATING_RUBRIC_DIGEST) {
          return { ok: false, code: "USER_RATING_RUBRIC_DIGEST_MISMATCH" };
        }
      }
      return scoreResult;
    },
    rollup(value: unknown) {
      return rollupResult(value);
    },
    candidate(value: unknown) {
      return schemaResult(validateCandidate, value);
    },
    approval(value: unknown) {
      return schemaResult(validateApproval, value);
    },
  });
}

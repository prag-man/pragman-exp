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
    return metric.direction !== "target"
      && metric.pass_rule.operator === "eq"
      && typeof metric.pass_rule.value === "boolean";
  }

  const categories = metric.categories ?? [];
  const identifiers = new Set(categories.map((category) => category.id));
  const ranks = new Set(categories.map((category) => category.rank));
  return metric.direction !== "target"
    && identifiers.size === categories.length
    && ranks.size === categories.length
    && metric.pass_rule.operator === "eq"
    && typeof metric.pass_rule.value === "string"
    && identifiers.has(metric.pass_rule.value);
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

export function createEventValidators(metricDefinitions: readonly unknown[] = []): EventValidators {
  const registry = new Map<string, SkillMetric>();
  for (const definition of metricDefinitions) {
    const result = metricResult(definition);
    if (!result.ok) throw new TypeError(`Invalid metric definition: ${result.code}`);
    registry.set(sha256Digest(result.value), result.value);
  }

  return Object.freeze({
    event(value: unknown) {
      return schemaResult(validateEvent, value);
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
      return scoreResult;
    },
    rollup(value: unknown) {
      return schemaResult(validateRollup, value);
    },
    candidate(value: unknown) {
      return schemaResult(validateCandidate, value);
    },
    approval(value: unknown) {
      return schemaResult(validateApproval, value);
    },
  });
}

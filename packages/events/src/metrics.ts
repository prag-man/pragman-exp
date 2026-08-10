import type { SkillEvent, SkillMetric, SkillScore } from "./types.ts";

export interface RateResult {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface NumericDistribution {
  count: number;
  sum: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
  values: number[];
}

function rate(numerator: number, denominator: number): RateResult {
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}

function quantile(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? sorted[0] ?? null;
}

export function numericDistribution(values: readonly number[]): NumericDistribution {
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    sum,
    mean: sorted.length === 0 ? null : sum / sorted.length,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    values: sorted,
  };
}

interface RoutingCase {
  trigger_expected: boolean | null;
  invoked: boolean;
}

function distinctRoutingCases(events: readonly SkillEvent[]): RoutingCase[] {
  const records = new Map<string, RoutingCase>();
  for (const record of [...events].sort((left, right) => left.timestamp.localeCompare(right.timestamp))) {
    if (record.event_type !== "eligible" && record.event_type !== "invoked") continue;
    const evaluationCase = record.eval_id === null
      ? record.invocation_id
      : `${record.eval_id}/${record.case_id ?? record.invocation_id}/${record.trial_id ?? "case"}`;
    const key = `${record.skill_id}/${record.skill_digest}/${evaluationCase}`;
    const previous = records.get(key) ?? { trigger_expected: null, invoked: false };
    records.set(key, {
      trigger_expected: record.event_type === "eligible" && record.trigger_expected !== null
        ? record.trigger_expected
        : previous.trigger_expected ?? record.trigger_expected,
      invoked: previous.invoked || (record.event_type === "invoked" && record.trigger_actual !== false),
    });
  }
  return [...records.values()];
}

export function calculateRoutingMetrics(events: readonly SkillEvent[]) {
  const cases = distinctRoutingCases(events);
  const known = cases.filter((record) => record.trigger_expected !== null);
  const expected = known.filter((record) => record.trigger_expected === true);
  const notExpected = known.filter((record) => record.trigger_expected === false);
  const invoked = known.filter((record) => record.invoked);
  const expectedAndInvoked = known.filter((record) => record.trigger_expected === true && record.invoked).length;
  const notExpectedAndNotInvoked = known.filter((record) => record.trigger_expected === false && !record.invoked).length;
  return {
    activation_precision: rate(expectedAndInvoked, invoked.length),
    activation_recall: rate(expectedAndInvoked, expected.length),
    no_op_accuracy: rate(notExpectedAndNotInvoked, notExpected.length),
    excluded_unknown_expectation: cases.length - known.length,
  };
}

export function metricPasses(metric: SkillMetric, value: SkillScore["value"]): boolean {
  const rule = metric.pass_rule;
  let comparable: boolean | number | string = value;
  if (metric.value_type === "category" && typeof value === "string" && rule.operator !== "eq") {
    const category = metric.categories?.find((entry) => entry.id === value);
    if (!category) throw new RangeError(`Unknown category value: ${value}`);
    comparable = category.rank;
  }
  if (rule.operator === "eq") return comparable === rule.value;
  if (typeof comparable !== "number") return false;
  if (rule.operator === "gte") return comparable >= rule.value;
  if (rule.operator === "lte") return comparable <= rule.value;
  if (rule.operator === "between") return comparable >= rule.min && comparable <= rule.max;
  return false;
}

function clampUtility(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function normalizeMetricUtility(metric: SkillMetric, value: SkillScore["value"]): number {
  if (metric.value_type === "boolean") {
    if (typeof value !== "boolean") throw new TypeError("Boolean metric requires a boolean value");
    const definition = metric.boolean_values?.find((entry) => entry.value === value);
    if (!definition) throw new RangeError("Boolean value is outside the metric domain");
    return definition.utility;
  }
  if (metric.value_type === "category") {
    if (typeof value !== "string") throw new TypeError("Category metric requires a category ID");
    const definition = metric.categories?.find((entry) => entry.id === value);
    if (!definition) throw new RangeError(`Unknown category value: ${value}`);
    return definition.utility;
  }
  if (typeof value !== "number" || !metric.number_range) throw new TypeError("Numeric metric requires a numeric domain");
  const { min, max } = metric.number_range;
  if (value < min || value > max || !(max > min)) throw new RangeError("Numeric value is outside the metric domain");
  if (metric.direction === "maximize") return clampUtility((value - min) / (max - min));
  if (metric.direction === "minimize") return clampUtility((max - value) / (max - min));
  if (metric.target !== undefined) {
    const denominator = Math.max(metric.target - min, max - metric.target);
    if (!(denominator > 0)) throw new RangeError("Point target has no positive normalization denominator");
    return clampUtility(1 - Math.min(1, Math.abs(value - metric.target) / denominator));
  }
  if (!metric.target_range) throw new TypeError("Target metric requires a point or range target");
  if (value >= metric.target_range.min && value <= metric.target_range.max) return 1;
  if (value < metric.target_range.min) {
    const denominator = metric.target_range.min - min;
    if (!(denominator > 0)) throw new RangeError("Range target has no lower normalization denominator");
    return clampUtility(1 - Math.min(1, (metric.target_range.min - value) / denominator));
  }
  const denominator = max - metric.target_range.max;
  if (!(denominator > 0)) throw new RangeError("Range target has no upper normalization denominator");
  return clampUtility(1 - Math.min(1, (value - metric.target_range.max) / denominator));
}

export function calculateScoreMetrics(scores: readonly SkillScore[], metric: SkillMetric) {
  const relevant = scores.filter((score) => score.metric_id === metric.metric_id);
  const numericValues = relevant.map((score) => typeof score.value === "number" ? score.value : typeof score.value === "boolean" ? Number(score.value) : null);
  const rawValues = numericValues.filter((value): value is number => value !== null);
  const utilities = relevant.map((score) => normalizeMetricUtility(metric, score.value));
  const passing = relevant.filter((score) => metricPasses(metric, score.value)).length;
  const rawDistribution = numericDistribution(rawValues);
  return {
    raw: { count: rawValues.length, sum: rawDistribution.sum, mean: rawDistribution.mean, values: rawDistribution.values },
    utility: numericDistribution(utilities),
    reliability: rate(passing, relevant.length),
  };
}

const STATUSES = ["succeeded", "partial", "failed", "cancelled", "handoff-required"] as const;

export function calculateOutcomeMetrics(events: readonly SkillEvent[], metric: SkillMetric) {
  const invokedIds = new Set(events.filter((record) => record.event_type === "invoked").map((record) => record.invocation_id));
  const terminalByInvocation = new Map<string, SkillEvent>();
  const verifiedByInvocation = new Map<string, SkillEvent>();
  for (const record of [...events].sort((left, right) => left.timestamp.localeCompare(right.timestamp))) {
    if (record.event_type === "completed" || record.event_type === "cancelled") terminalByInvocation.set(record.invocation_id, record);
    if (record.event_type === "verified") verifiedByInvocation.set(record.invocation_id, record);
  }
  const terminals = [...terminalByInvocation.values()];
  const eligible = terminals.filter((terminal) => {
    const verification = verifiedByInvocation.get(terminal.invocation_id);
    return metric.eligible_verification_codes.includes(verification?.outcome_code ?? terminal.outcome_code ?? "");
  });
  const verifiedSuccesses = eligible.filter((terminal) => {
    const verification = verifiedByInvocation.get(terminal.invocation_id);
    return verification !== undefined
      && metric.eligible_verification_codes.includes(verification.outcome_code ?? "")
      && verification.status === "succeeded"
      && (verification.verification_checks === 0 || verification.verification_passes > 0);
  });
  const statusCounts = Object.fromEntries(STATUSES.map((status) => [status, terminals.filter((record) => record.status === status).length])) as Record<(typeof STATUSES)[number], number>;
  return {
    completion: rate(terminals.length, invokedIds.size),
    verified_success: rate(verifiedSuccesses.length, eligible.length),
    status_counts: statusCounts,
    distributions: {
      duration_ms: numericDistribution(terminals.map((record) => record.duration_ms)),
      retries: numericDistribution(terminals.map((record) => record.retries)),
      rework_cycles: numericDistribution(terminals.map((record) => record.rework_cycles)),
      tool_calls: numericDistribution(terminals.map((record) => record.tool_calls)),
      verification_checks: numericDistribution(terminals.map((record) => record.verification_checks)),
      verification_passes: numericDistribution(terminals.map((record) => record.verification_passes)),
    },
  };
}

export const normalizedUtility = normalizeMetricUtility;

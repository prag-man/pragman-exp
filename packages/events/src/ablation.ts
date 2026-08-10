import { metricPasses, normalizeMetricUtility } from "./metrics.ts";
import type { SkillMetric, SkillScore } from "./types.ts";

export type AblationArm = "skill-on" | "skill-off";

export interface AblationTrial {
  arm: AblationArm;
  eval_id: string;
  eval_corpus_digest: string;
  trial_policy_digest: string;
  case_id: string;
  trial_id: string;
  skill_digest: string;
  provider: string;
  provider_digest: string;
  host: string;
  host_version: string;
  model: string;
  model_version: string;
  harness_version: string;
  metric_id: string;
  metric_definition_digest: string;
  grader_id: string;
  grader_version: string;
  rubric_digest: string;
  raw_value: SkillScore["value"];
  verified_success: boolean;
  duration_ms: number;
  retries: number;
  rework_cycles: number;
  tool_calls: number;
}

export type AblationIncomparabilityReason =
  | "MISSING_SKILL_ON_ARM" | "MISSING_SKILL_OFF_ARM" | "DUPLICATE_PAIRED_TRIAL"
  | "PAIRED_TRIAL_IDS_MISMATCH" | "EVAL_ID_MISMATCH" | "EVAL_CORPUS_DIGEST_MISMATCH"
  | "TRIAL_POLICY_DIGEST_MISMATCH" | "SKILL_DIGEST_MISMATCH" | "PROVIDER_MISMATCH"
  | "PROVIDER_DIGEST_MISMATCH" | "HOST_MISMATCH" | "HOST_VERSION_MISMATCH" | "MODEL_MISMATCH"
  | "MODEL_VERSION_MISMATCH" | "HARNESS_VERSION_MISMATCH" | "METRIC_ID_MISMATCH"
  | "METRIC_DEFINITION_DIGEST_MISMATCH" | "GRADER_ID_MISMATCH" | "GRADER_VERSION_MISMATCH"
  | "RUBRIC_DIGEST_MISMATCH";

const COMPARABLE_FIELDS = [
  ["eval_id", "EVAL_ID_MISMATCH"], ["eval_corpus_digest", "EVAL_CORPUS_DIGEST_MISMATCH"],
  ["trial_policy_digest", "TRIAL_POLICY_DIGEST_MISMATCH"], ["skill_digest", "SKILL_DIGEST_MISMATCH"],
  ["provider", "PROVIDER_MISMATCH"], ["provider_digest", "PROVIDER_DIGEST_MISMATCH"],
  ["host", "HOST_MISMATCH"], ["host_version", "HOST_VERSION_MISMATCH"], ["model", "MODEL_MISMATCH"],
  ["model_version", "MODEL_VERSION_MISMATCH"], ["harness_version", "HARNESS_VERSION_MISMATCH"],
  ["metric_id", "METRIC_ID_MISMATCH"], ["metric_definition_digest", "METRIC_DEFINITION_DIGEST_MISMATCH"],
  ["grader_id", "GRADER_ID_MISMATCH"], ["grader_version", "GRADER_VERSION_MISMATCH"],
  ["rubric_digest", "RUBRIC_DIGEST_MISMATCH"],
] as const satisfies readonly (readonly [keyof AblationTrial, AblationIncomparabilityReason])[];

export interface SanitizedAblationArmResult {
  raw_value: SkillScore["value"];
  utility: number;
  passed: boolean;
  verified_success: boolean;
  duration_ms: number;
  retries: number;
  rework_cycles: number;
  tool_calls: number;
}

export interface AblationPairResult {
  pair_id: string;
  case_id: string;
  trial_id: string;
  skill_on: SanitizedAblationArmResult;
  skill_off: SanitizedAblationArmResult;
  raw_delta: number | null;
  utility_delta: number;
  pass_delta: number;
  verified_success_delta: number;
  efficiency_delta: { duration_ms: number; retries: number; rework_cycles: number; tool_calls: number };
}

export type AblationComparison =
  | { status: "INCOMPARABLE"; reasons: AblationIncomparabilityReason[] }
  | {
    status: "COMPARABLE"; pair_count: number; raw_metric_delta: number | null; skill_on_raw_mean: number | null;
    skill_off_raw_mean: number | null; utility_lift: number; outcome_lift: number | null; pass_lift: number;
    verified_success_lift: number;
    efficiency_delta: { duration_ms: number; retries: number; rework_cycles: number; tool_calls: number };
    pairs: AblationPairResult[]; significance: { confidence_level: 0.95; lower: number; upper: number; significant: boolean } | null;
    significance_reason: "MINIMUM_20_PAIRS_REQUIRED" | null;
  };

const TRIAL_FIELDS = new Set<keyof AblationTrial>([
  "arm", "eval_id", "eval_corpus_digest", "trial_policy_digest", "case_id", "trial_id", "skill_digest",
  "provider", "provider_digest", "host", "host_version", "model", "model_version", "harness_version",
  "metric_id", "metric_definition_digest", "grader_id", "grader_version", "rubric_digest", "raw_value",
  "verified_success", "duration_ms", "retries", "rework_cycles", "tool_calls",
]);
const DIGEST_FIELDS = [
  "eval_corpus_digest", "trial_policy_digest", "skill_digest", "provider_digest", "metric_definition_digest", "rubric_digest",
] as const satisfies readonly (keyof AblationTrial)[];
const ID_FIELDS = ["eval_id", "case_id", "trial_id", "provider", "host", "model", "metric_id", "grader_id"] as const;
const VERSION_FIELDS = ["host_version", "model_version", "harness_version", "grader_version"] as const;
const COUNTER_FIELDS = ["duration_ms", "retries", "rework_cycles", "tool_calls"] as const;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const KNOWN_SECRET = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})/;

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function stableNumber(value: number): number {
  return Number(value.toPrecision(15));
}

function rawNumber(value: AblationTrial["raw_value"]): number | null {
  return typeof value === "number" ? value : typeof value === "boolean" ? Number(value) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isSafeToken(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && SAFE_TOKEN.test(value) && !KNOWN_SECRET.test(value);
}

function assertTrialShape(value: unknown): asserts value is AblationTrial {
  if (!isPlainObject(value)) throw new TypeError("Ablation trial must be a plain content-free object");
  const keys = Object.keys(value);
  if (keys.length !== TRIAL_FIELDS.size || keys.some((key) => !TRIAL_FIELDS.has(key as keyof AblationTrial))) {
    throw new TypeError("Ablation trial must use the exact content-free schema");
  }
  if (value.arm !== "skill-on" && value.arm !== "skill-off") throw new TypeError("Invalid ablation arm");
  for (const field of ID_FIELDS) if (!isSafeToken(value[field], 128)) throw new TypeError(`Invalid ablation identity: ${field}`);
  for (const field of VERSION_FIELDS) if (!isSafeToken(value[field], 64)) throw new TypeError(`Invalid ablation version: ${field}`);
  for (const field of DIGEST_FIELDS) if (typeof value[field] !== "string" || !SHA256.test(value[field])) throw new TypeError(`Invalid ablation digest: ${field}`);
  for (const field of COUNTER_FIELDS) if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) throw new TypeError(`Invalid ablation counter: ${field}`);
  if (typeof value.verified_success !== "boolean") throw new TypeError("Invalid verified-success value");
  if (!(typeof value.raw_value === "boolean"
    || (typeof value.raw_value === "number" && Number.isFinite(value.raw_value))
    || isSafeToken(value.raw_value, 64))) throw new TypeError("Invalid raw metric value");
}

function sanitizedArm(trial: AblationTrial, metric: SkillMetric): SanitizedAblationArmResult {
  if (trial.metric_id !== metric.metric_id) throw new RangeError("Registered metric ID does not match the trial");
  const utility = normalizeMetricUtility(metric, trial.raw_value);
  const passed = metricPasses(metric, trial.raw_value);
  return {
    raw_value: trial.raw_value,
    utility,
    passed,
    verified_success: trial.verified_success,
    duration_ms: trial.duration_ms,
    retries: trial.retries,
    rework_cycles: trial.rework_cycles,
    tool_calls: trial.tool_calls,
  };
}

export function compareAblation(
  trialsValue: readonly AblationTrial[],
  metricRegistry: ReadonlyMap<string, SkillMetric>,
): AblationComparison {
  if (!Array.isArray(trialsValue) || !(metricRegistry instanceof Map)) {
    throw new TypeError("Ablation comparison requires trials and a registered metric map");
  }
  for (const trial of trialsValue) assertTrialShape(trial);
  const trials = trialsValue as readonly AblationTrial[];
  const reasons = new Set<AblationIncomparabilityReason>();
  const on = trials.filter((trial) => trial.arm === "skill-on");
  const off = trials.filter((trial) => trial.arm === "skill-off");
  if (on.length === 0) reasons.add("MISSING_SKILL_ON_ARM");
  if (off.length === 0) reasons.add("MISSING_SKILL_OFF_ARM");
  const first = trials[0];
  if (first) {
    for (const [field, reason] of COMPARABLE_FIELDS) {
      if (trials.some((trial) => trial[field] !== first[field])) reasons.add(reason);
    }
  }
  const pairKey = (trial: AblationTrial) => `${trial.case_id}/${trial.trial_id}`;
  const onMap = new Map<string, AblationTrial>();
  const offMap = new Map<string, AblationTrial>();
  for (const trial of on) {
    const key = pairKey(trial);
    if (onMap.has(key)) reasons.add("DUPLICATE_PAIRED_TRIAL");
    onMap.set(key, trial);
  }
  for (const trial of off) {
    const key = pairKey(trial);
    if (offMap.has(key)) reasons.add("DUPLICATE_PAIRED_TRIAL");
    offMap.set(key, trial);
  }
  if (on.length > 0 && off.length > 0
    && (onMap.size !== offMap.size || [...onMap.keys()].some((key) => !offMap.has(key)))) reasons.add("PAIRED_TRIAL_IDS_MISMATCH");
  if (reasons.size > 0) return { status: "INCOMPARABLE", reasons: [...reasons] };

  const metricDigest = first!.metric_definition_digest;
  const metric = metricRegistry.get(metricDigest);
  if (!metric) throw new RangeError("Referenced metric definition is not registered");
  const pairs = [...onMap.keys()].sort().map((key): AblationPairResult => {
    const onTrial = onMap.get(key)!;
    const offTrial = offMap.get(key)!;
    const skillOn = sanitizedArm(onTrial, metric);
    const skillOff = sanitizedArm(offTrial, metric);
    const onRaw = rawNumber(skillOn.raw_value);
    const offRaw = rawNumber(skillOff.raw_value);
    return {
      pair_id: key,
      case_id: onTrial.case_id,
      trial_id: onTrial.trial_id,
      skill_on: skillOn,
      skill_off: skillOff,
      raw_delta: onRaw === null || offRaw === null ? null : stableNumber(onRaw - offRaw),
      utility_delta: stableNumber(skillOn.utility - skillOff.utility),
      pass_delta: Number(skillOn.passed) - Number(skillOff.passed),
      verified_success_delta: Number(skillOn.verified_success) - Number(skillOff.verified_success),
      efficiency_delta: {
        duration_ms: skillOn.duration_ms - skillOff.duration_ms,
        retries: skillOn.retries - skillOff.retries,
        rework_cycles: skillOn.rework_cycles - skillOff.rework_cycles,
        tool_calls: skillOn.tool_calls - skillOff.tool_calls,
      },
    };
  });
  const onRaw = pairs.map((pair) => rawNumber(pair.skill_on.raw_value));
  const offRaw = pairs.map((pair) => rawNumber(pair.skill_off.raw_value));
  const hasRaw = onRaw.every((value): value is number => value !== null) && offRaw.every((value): value is number => value !== null);
  const utilityDeltas = pairs.map((pair) => pair.utility_delta);
  let significance: Extract<AblationComparison, { status: "COMPARABLE" }>["significance"] = null;
  if (pairs.length >= 20) {
    const average = mean(utilityDeltas);
    const variance = utilityDeltas.reduce((total, value) => total + (value - average) ** 2, 0) / (utilityDeltas.length - 1);
    const margin = 1.96 * Math.sqrt(variance / utilityDeltas.length);
    significance = { confidence_level: 0.95, lower: average - margin, upper: average + margin, significant: average - margin > 0 || average + margin < 0 };
  }
  const outcomeLift = hasRaw ? stableNumber(mean(onRaw) - mean(offRaw)) : null;
  const averageDelta = (field: keyof AblationPairResult["efficiency_delta"]) => mean(pairs.map((pair) => pair.efficiency_delta[field]));
  return {
    status: "COMPARABLE",
    pair_count: pairs.length,
    raw_metric_delta: outcomeLift,
    skill_on_raw_mean: hasRaw ? stableNumber(mean(onRaw)) : null,
    skill_off_raw_mean: hasRaw ? stableNumber(mean(offRaw)) : null,
    outcome_lift: outcomeLift,
    utility_lift: stableNumber(mean(utilityDeltas)),
    pass_lift: stableNumber(mean(pairs.map((pair) => pair.pass_delta))),
    verified_success_lift: stableNumber(mean(pairs.map((pair) => pair.verified_success_delta))),
    efficiency_delta: {
      duration_ms: stableNumber(averageDelta("duration_ms")),
      retries: stableNumber(averageDelta("retries")),
      rework_cycles: stableNumber(averageDelta("rework_cycles")),
      tool_calls: stableNumber(averageDelta("tool_calls")),
    },
    pairs,
    significance,
    significance_reason: pairs.length < 20 ? "MINIMUM_20_PAIRS_REQUIRED" : null,
  };
}

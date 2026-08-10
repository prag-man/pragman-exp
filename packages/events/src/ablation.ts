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
  raw_value: boolean | number | string;
  utility: number;
  passed: boolean;
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

export interface AblationPairResult {
  pair_id: string;
  case_id: string;
  trial_id: string;
  skill_on: AblationTrial;
  skill_off: AblationTrial;
  raw_delta: number | null;
  utility_delta: number;
  verified_success_delta: number;
  efficiency_delta: { duration_ms: number; retries: number; rework_cycles: number; tool_calls: number };
}

export type AblationComparison =
  | { status: "INCOMPARABLE"; reasons: AblationIncomparabilityReason[] }
  | {
    status: "COMPARABLE"; pair_count: number; raw_metric_delta: number | null; skill_on_raw_mean: number | null;
    skill_off_raw_mean: number | null; utility_lift: number; outcome_lift: number; verified_success_lift: number;
    efficiency_delta: { duration_ms: number; retries: number; rework_cycles: number; tool_calls: number };
    pairs: AblationPairResult[]; significance: { confidence_level: 0.95; lower: number; upper: number; significant: boolean } | null;
    significance_reason: "MINIMUM_20_PAIRS_REQUIRED" | null;
  };

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function stableNumber(value: number): number {
  return Number(value.toPrecision(15));
}

function rawNumber(value: AblationTrial["raw_value"]): number | null {
  return typeof value === "number" ? value : typeof value === "boolean" ? Number(value) : null;
}

export function compareAblation(trials: readonly AblationTrial[]): AblationComparison {
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

  const pairs = [...onMap.keys()].sort().map((key): AblationPairResult => {
    const skillOn = onMap.get(key)!;
    const skillOff = offMap.get(key)!;
    const onRaw = rawNumber(skillOn.raw_value);
    const offRaw = rawNumber(skillOff.raw_value);
    return {
      pair_id: key, case_id: skillOn.case_id, trial_id: skillOn.trial_id, skill_on: skillOn, skill_off: skillOff,
      raw_delta: onRaw === null || offRaw === null ? null : onRaw - offRaw,
      utility_delta: skillOn.utility - skillOff.utility,
      verified_success_delta: Number(skillOn.verified_success) - Number(skillOff.verified_success),
      efficiency_delta: {
        duration_ms: skillOn.duration_ms - skillOff.duration_ms, retries: skillOn.retries - skillOff.retries,
        rework_cycles: skillOn.rework_cycles - skillOff.rework_cycles, tool_calls: skillOn.tool_calls - skillOff.tool_calls,
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
  const averageDelta = (field: keyof AblationPairResult["efficiency_delta"]) => mean(pairs.map((pair) => pair.efficiency_delta[field]));
  return {
    status: "COMPARABLE", pair_count: pairs.length,
    raw_metric_delta: hasRaw ? mean(onRaw) - mean(offRaw) : null,
    skill_on_raw_mean: hasRaw ? mean(onRaw) : null, skill_off_raw_mean: hasRaw ? mean(offRaw) : null,
    utility_lift: stableNumber(mean(utilityDeltas)), outcome_lift: stableNumber(mean(pairs.map((pair) => Number(pair.skill_on.passed) - Number(pair.skill_off.passed)))),
    verified_success_lift: stableNumber(mean(pairs.map((pair) => pair.verified_success_delta))),
    efficiency_delta: { duration_ms: stableNumber(averageDelta("duration_ms")), retries: stableNumber(averageDelta("retries")), rework_cycles: stableNumber(averageDelta("rework_cycles")), tool_calls: stableNumber(averageDelta("tool_calls")) },
    pairs, significance, significance_reason: pairs.length < 20 ? "MINIMUM_20_PAIRS_REQUIRED" : null,
  };
}

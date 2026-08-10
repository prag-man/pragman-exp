import { canonicalJson, sha256Digest } from "./canonical.ts";
import { metricPasses, normalizeMetricUtility } from "./metrics.ts";
import type { SkillEvent, SkillMetric, SkillRollup, SkillScore } from "./types.ts";

type MetricRegistry = ReadonlyMap<string, SkillMetric>;
type Dimensions = SkillRollup["dimensions"];
type HistogramName = keyof SkillRollup["histograms"];

const SOURCES = ["router", "host-adapter", "cli", "eval-runner", "user-report"] as const;
const EVENT_TYPES = ["eligible", "invoked", "completed", "cancelled", "verified"] as const;
const HISTOGRAM_LIMITS: Record<HistogramName, readonly number[]> = {
  duration_ms: [0, 10, 50, 100, 250, 500, 1_000, 5_000, 30_000, 60_000],
  tool_calls: [0, 1, 2, 3, 5, 8, 13, 21],
  retries: [0, 1, 2, 3, 5, 8],
  rework_cycles: [0, 1, 2, 3, 5, 8],
};

function utcStart(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function addUtcDays(timestamp: string, days: number): string {
  const value = new Date(timestamp);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString();
}

function histogram(values: readonly number[], limits: readonly number[]): number[] {
  const buckets = Array.from({ length: limits.length + 1 }, () => 0);
  for (const value of values) {
    const index = limits.findIndex((limit) => value <= limit);
    buckets[index < 0 ? buckets.length - 1 : index]! += 1;
  }
  return buckets;
}

function zeroCounts(): SkillRollup["counts"] {
  return { eligible: 0, invoked: 0, completed: 0, cancelled: 0, verified: 0, incomplete: 0 };
}

function zeroSums(): SkillRollup["sums"] {
  return { duration_ms: 0, tool_calls: 0, retries: 0, rework_cycles: 0, verification_checks: 0, verification_passes: 0 };
}

function zeroSources(): SkillRollup["observation_source_counts"] {
  return { router: 0, "host-adapter": 0, cli: 0, "eval-runner": 0, "user-report": 0 };
}

const SCORE_IDENTITY_FIELDS = [
  "invocation_id", "metric_id", "metric_definition_digest", "value_type", "source", "grader_id", "grader_version", "rubric_digest",
] as const satisfies readonly (keyof SkillScore)[];

function validScoreChains(scores: readonly SkillScore[]): Array<{ latest: SkillScore; records: SkillScore[] }> {
  const byId = new Map(scores.map((score) => [score.score_id, score]));
  const proposedSuccessors = new Map<string, SkillScore[]>();
  for (const score of scores) {
    if (score.supersedes_score_id !== undefined) {
      const list = proposedSuccessors.get(score.supersedes_score_id) ?? [];
      list.push(score);
      proposedSuccessors.set(score.supersedes_score_id, list);
    }
  }
  const roots = scores.filter((score) => score.supersedes_score_id === undefined).sort((left, right) => left.score_id.localeCompare(right.score_id));
  return roots.map((root) => {
    const records = [root];
    let cursor = root;
    const visited = new Set([root.score_id]);
    for (;;) {
      const candidates = proposedSuccessors.get(cursor.score_id) ?? [];
      if (candidates.length !== 1) break;
      const candidate = candidates[0]!;
      const identityMatches = SCORE_IDENTITY_FIELDS.every((field) => candidate[field] === cursor[field]);
      if (!identityMatches || visited.has(candidate.score_id) || !byId.has(candidate.score_id)
        || Date.parse(candidate.timestamp) <= Date.parse(cursor.timestamp)) break;
      records.push(candidate);
      visited.add(candidate.score_id);
      cursor = candidate;
    }
    return { latest: cursor, records };
  });
}

function baseDimensions(event: SkillEvent, score: SkillScore | null): Dimensions {
  return {
    skill_id: event.skill_id, skill_version: event.skill_version, skill_digest: event.skill_digest, skill_type: event.skill_type,
    host: event.host, host_version: event.host_version, model: event.model, model_version: event.model_version,
    harness_version: event.harness_version, invocation_mode: event.invocation_mode, provider: event.provider,
    provider_digest: event.provider_digest, event_cohort: event.eval_id === null ? "production" : "evaluation",
    eval_corpus_digest: event.eval_corpus_digest, trial_policy_digest: event.trial_policy_digest,
    metric_id: score?.metric_id ?? null, metric_definition_digest: score?.metric_definition_digest ?? null,
    rubric_digest: score?.rubric_digest ?? null, ablation_arm: event.ablation_arm,
  };
}

interface GroupInput {
  dimensions: Dimensions;
  events: SkillEvent[];
  scoreChains: Array<{ latest: SkillScore; records: SkillScore[] }>;
}

function sourceDigest(records: readonly (SkillEvent | SkillScore)[]): string {
  const canonicalRecords = records.map((record) => canonicalJson(record)).sort();
  return sha256Digest(canonicalRecords);
}

function rollupFromGroup(group: GroupInput, period: "daily" | "weekly", periodStart: string, periodEnd: string): SkillRollup {
  const counts = zeroCounts();
  for (const event of group.events) counts[event.event_type] += 1;
  const invokedIds = new Set(group.events.filter((event) => event.event_type === "invoked").map((event) => event.invocation_id));
  const terminalIds = new Set(group.events.filter((event) => event.event_type === "completed" || event.event_type === "cancelled").map((event) => event.invocation_id));
  counts.incomplete = [...invokedIds].filter((id) => !terminalIds.has(id)).length;
  const terminals = group.events.filter((event) => event.event_type === "completed" || event.event_type === "cancelled");
  const sums = zeroSums();
  for (const event of terminals) {
    sums.duration_ms += event.duration_ms; sums.tool_calls += event.tool_calls; sums.retries += event.retries;
    sums.rework_cycles += event.rework_cycles; sums.verification_checks += event.verification_checks;
    sums.verification_passes += event.verification_passes;
  }
  const observationSourceCounts = zeroSources();
  for (const event of group.events) observationSourceCounts[event.observation_source] += 1;
  const latestScores = group.scoreChains.map((chain) => chain.latest);
  const metric = latestScores[0] ? undefined : undefined;
  void metric;
  const records = [...group.events, ...group.scoreChains.flatMap((chain) => chain.records)];
  const digest = sourceDigest(records);
  return {
    schema_version: 1, rollup_id: `${period}-${periodStart.slice(0, 10)}-${sha256Digest({ dimensions: group.dimensions, digest }).slice(0, 20)}`,
    period, period_start: periodStart, period_end: periodEnd, dimensions: group.dimensions, counts, sums,
    histograms: {
      duration_ms: histogram(terminals.map((event) => event.duration_ms), HISTOGRAM_LIMITS.duration_ms),
      tool_calls: histogram(terminals.map((event) => event.tool_calls), HISTOGRAM_LIMITS.tool_calls),
      retries: histogram(terminals.map((event) => event.retries), HISTOGRAM_LIMITS.retries),
      rework_cycles: histogram(terminals.map((event) => event.rework_cycles), HISTOGRAM_LIMITS.rework_cycles),
    },
    score_aggregate: { count: latestScores.length, sum: 0, utility_sum: 0, pass_count: 0, correction_count: group.scoreChains.reduce((total, chain) => total + chain.records.length - 1, 0) },
    observation_source_counts: observationSourceCounts, source_record_count: records.length, source_record_digest: digest,
    sealed: false, storage_scope: "local",
  };
}

function assignScores(rollup: SkillRollup, chains: GroupInput["scoreChains"], registry: MetricRegistry): void {
  for (const chain of chains) {
    const score = chain.latest;
    const metric = registry.get(score.metric_definition_digest);
    if (!metric) continue;
    if (typeof score.value === "number") rollup.score_aggregate.sum += score.value;
    else if (typeof score.value === "boolean") rollup.score_aggregate.sum += Number(score.value);
    rollup.score_aggregate.utility_sum += normalizeMetricUtility(metric, score.value);
    if (metricPasses(metric, score.value)) rollup.score_aggregate.pass_count += 1;
  }
}

export function buildDailyRollups(
  events: readonly SkillEvent[], scores: readonly SkillScore[], registry: MetricRegistry, date: string,
): SkillRollup[] {
  const invocationAnchors = new Map<string, string>();
  for (const event of [...events].sort((left, right) => left.timestamp.localeCompare(right.timestamp))) {
    const current = invocationAnchors.get(event.invocation_id);
    if (event.event_type === "invoked") {
      if (current === undefined || event.timestamp < current) invocationAnchors.set(event.invocation_id, event.timestamp);
    } else if (current === undefined) {
      invocationAnchors.set(event.invocation_id, event.timestamp);
    }
  }
  const invokedAnchors = new Map(events
    .filter((event) => event.event_type === "invoked")
    .map((event) => [event.invocation_id, event.timestamp]));
  for (const [invocationId, timestamp] of invokedAnchors) invocationAnchors.set(invocationId, timestamp);
  const dayEvents = events.filter((event) => invocationAnchors.get(event.invocation_id)?.slice(0, 10) === date);
  const eventsByInvocation = new Map<string, SkillEvent[]>();
  for (const event of dayEvents) {
    const records = eventsByInvocation.get(event.invocation_id) ?? [];
    records.push(event);
    eventsByInvocation.set(event.invocation_id, records);
  }
  const dayInvocationIds = new Set(eventsByInvocation.keys());
  const scoreChains = validScoreChains(scores.filter((score) => dayInvocationIds.has(score.invocation_id) && registry.has(score.metric_definition_digest)));
  const chainsByInvocation = new Map<string, typeof scoreChains>();
  for (const chain of scoreChains) {
    const records = chainsByInvocation.get(chain.latest.invocation_id) ?? [];
    records.push(chain);
    chainsByInvocation.set(chain.latest.invocation_id, records);
  }
  const groups = new Map<string, GroupInput>();
  for (const [invocationId, invocationEvents] of eventsByInvocation) {
    const anchor = invocationEvents.find((event) => event.event_type === "invoked") ?? invocationEvents[0]!;
    const invocationChains = chainsByInvocation.get(invocationId) ?? [];
    const scorePartitions: Array<{ score: SkillScore | null; chains: typeof scoreChains }> = invocationChains.length === 0
      ? [{ score: null, chains: [] }]
      : invocationChains.map((chain) => ({ score: chain.latest, chains: [chain] }));
    for (const partition of scorePartitions) {
      const dimensions = baseDimensions(anchor, partition.score);
      const key = canonicalJson(dimensions);
      const group = groups.get(key) ?? { dimensions, events: [], scoreChains: [] };
      group.events.push(...invocationEvents);
      group.scoreChains.push(...partition.chains);
      groups.set(key, group);
    }
  }
  const periodStart = utcStart(date);
  return [...groups.values()].map((group) => {
    const rollup = rollupFromGroup(group, "daily", periodStart, addUtcDays(periodStart, 1));
    assignScores(rollup, group.scoreChains, registry);
    return rollup;
  }).sort((left, right) => canonicalJson(left.dimensions).localeCompare(canonicalJson(right.dimensions)));
}

function addArrays(left: readonly number[], right: readonly number[]): number[] {
  const length = Math.max(left.length, right.length);
  return Array.from({ length }, (_, index) => (left[index] ?? 0) + (right[index] ?? 0));
}

export function aggregateWeeklyRollups(dailyRollups: readonly SkillRollup[], weekStartDate: string): SkillRollup[] {
  const periodStart = utcStart(weekStartDate);
  const periodEnd = addUtcDays(periodStart, 7);
  const relevant = dailyRollups.filter((rollup) => rollup.period === "daily" && rollup.period_start >= periodStart && rollup.period_start < periodEnd);
  const groups = new Map<string, SkillRollup[]>();
  for (const rollup of relevant) {
    const key = canonicalJson(rollup.dimensions);
    const records = groups.get(key) ?? [];
    records.push(rollup);
    groups.set(key, records);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, records]) => {
    const sorted = [...records].sort((left, right) => left.period_start.localeCompare(right.period_start));
    const first = sorted[0]!;
    const result: SkillRollup = {
      ...structuredClone(first), period: "weekly", period_start: periodStart, period_end: periodEnd, sealed: false,
      rollup_id: `weekly-${weekStartDate}-${sha256Digest({ dimensions: first.dimensions, sources: sorted.map((entry) => entry.source_record_digest) }).slice(0, 20)}`,
      counts: zeroCounts(), sums: zeroSums(), histograms: { duration_ms: [], tool_calls: [], retries: [], rework_cycles: [] },
      score_aggregate: { count: 0, sum: 0, utility_sum: 0, pass_count: 0, correction_count: 0 },
      observation_source_counts: zeroSources(), source_record_count: 0,
      source_record_digest: sha256Digest(sorted.map((entry) => ({ count: entry.source_record_count, digest: entry.source_record_digest }))),
    };
    for (const daily of sorted) {
      for (const type of [...EVENT_TYPES, "incomplete"] as const) result.counts[type] += daily.counts[type];
      for (const name of Object.keys(result.sums) as Array<keyof SkillRollup["sums"]>) result.sums[name] += daily.sums[name];
      for (const name of Object.keys(result.histograms) as HistogramName[]) result.histograms[name] = addArrays(result.histograms[name], daily.histograms[name]);
      for (const source of SOURCES) result.observation_source_counts[source] += daily.observation_source_counts[source];
      result.score_aggregate.count += daily.score_aggregate.count; result.score_aggregate.sum += daily.score_aggregate.sum;
      result.score_aggregate.utility_sum += daily.score_aggregate.utility_sum; result.score_aggregate.pass_count += daily.score_aggregate.pass_count;
      result.score_aggregate.correction_count += daily.score_aggregate.correction_count; result.source_record_count += daily.source_record_count;
    }
    return result;
  });
}

export function sealRollup(rollup: SkillRollup): SkillRollup {
  const { rollup_id: _rollupId, ...content } = rollup;
  void _rollupId;
  return { ...structuredClone(rollup), rollup_id: `sealed-${sha256Digest({ ...content, sealed: true }).slice(0, 24)}`, sealed: true };
}

export function verifyRollup(
  rollup: SkillRollup, events: readonly SkillEvent[], scores: readonly SkillScore[], registry: MetricRegistry,
): { valid: boolean; expected_source_record_count: number; actual_source_record_count: number; expected_source_record_digest: string | null; actual_source_record_digest: string } {
  const expected = buildDailyRollups(events, scores, registry, rollup.period_start.slice(0, 10))
    .find((candidate) => canonicalJson(candidate.dimensions) === canonicalJson(rollup.dimensions));
  return {
    valid: expected !== undefined && expected.source_record_count === rollup.source_record_count && expected.source_record_digest === rollup.source_record_digest,
    expected_source_record_count: expected?.source_record_count ?? 0, actual_source_record_count: rollup.source_record_count,
    expected_source_record_digest: expected?.source_record_digest ?? null, actual_source_record_digest: rollup.source_record_digest,
  };
}

function datesBetween(fromDate: string, throughDate: string): string[] {
  const result: string[] = [];
  for (let cursor = utcStart(fromDate); cursor <= utcStart(throughDate); cursor = addUtcDays(cursor, 1)) result.push(cursor.slice(0, 10));
  return result;
}

export function rebuildRollups(
  existingDaily: readonly SkillRollup[], events: readonly SkillEvent[], scores: readonly SkillScore[], registry: MetricRegistry,
  fromDate: string, throughDate: string,
): { daily: SkillRollup[]; weekly: SkillRollup[] } {
  const rebuildDates = new Set(datesBetween(fromDate, throughDate));
  const preserved = existingDaily.filter((rollup) => rollup.sealed || !rebuildDates.has(rollup.period_start.slice(0, 10)));
  const sealedKeys = new Set(existingDaily.filter((rollup) => rollup.sealed)
    .map((rollup) => `${rollup.period_start.slice(0, 10)}:${canonicalJson(rollup.dimensions)}`));
  const rebuilt = [...rebuildDates].sort().flatMap((date) => buildDailyRollups(events, scores, registry, date)
    .filter((rollup) => !sealedKeys.has(`${date}:${canonicalJson(rollup.dimensions)}`)));
  const daily = [...preserved, ...rebuilt].sort((left, right) => left.period_start.localeCompare(right.period_start) || left.rollup_id.localeCompare(right.rollup_id));
  const weekStarts = new Set(daily.map((rollup) => {
    const date = new Date(rollup.period_start);
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - mondayOffset);
    return date.toISOString().slice(0, 10);
  }));
  const weekly = [...weekStarts].sort().flatMap((weekStart) => aggregateWeeklyRollups(daily, weekStart));
  return { daily, weekly };
}

export const buildRollups = buildDailyRollups;

import { canonicalJson, sha256Digest } from "./canonical.ts";
import type { EvalCandidate, EvalCandidateApproval, SkillEvent, SkillRollup, SkillScore } from "./types.ts";

export interface RetentionQuarantineRecord {
  quarantine_id: string;
  timestamp: string;
}

export interface RetentionState {
  events: SkillEvent[];
  scores: SkillScore[];
  candidates: EvalCandidate[];
  approvals: EvalCandidateApproval[];
  daily_rollups: SkillRollup[];
  weekly_rollups: SkillRollup[];
  quarantine: RetentionQuarantineRecord[];
}

export interface RetentionPolicy {
  raw_days: number;
  candidate_days: number;
  quarantine_days: number;
  daily_rollup_years: number;
  plan_ttl_ms: number;
}

export type PurgeClass = "raw" | "candidates" | "daily-rollups" | "weekly-rollups" | "quarantine";

export interface RetentionRemovalSet {
  event_ids: string[];
  score_ids: string[];
  candidate_ids: string[];
  approval_ids: string[];
  daily_rollup_ids: string[];
  weekly_rollup_ids: string[];
  quarantine_ids: string[];
}

interface PlanBase {
  schema_version: 1;
  kind: "automatic-retention" | "explicit-purge";
  created_at: string;
  expires_at: string;
  current_state_digest: string;
  remove: RetentionRemovalSet;
  compact_days: string[];
  affected_weeks: string[];
  history_rebuildable: boolean;
  plan_digest: string;
}

export interface AutomaticRetentionPlan extends PlanBase {
  kind: "automatic-retention";
  policy: RetentionPolicy;
}

export interface ExplicitPurgePlan extends PlanBase {
  kind: "explicit-purge";
  selection: { classes: PurgeClass[]; from: string; through: string };
  history_rebuildable: false;
}

export type RetentionPlan = AutomaticRetentionPlan | ExplicitPurgePlan;

export interface RetentionApplyDependencies {
  now(): Date;
  withMutationLock<T>(operation: () => Promise<T>): Promise<T>;
  sealAndVerifyDaily(date: string): Promise<boolean>;
  recomputeWeekly(weekStart: string): Promise<boolean>;
}

export type RetentionApplyResult =
  | { applied: true; reason: null; state: RetentionState; removed: RetentionRemovalSet; history_rebuildable: boolean }
  | { applied: false; reason: "PLAN_DIGEST_INVALID" | "PLAN_EXPIRED" | "STALE_STATE" | "RETENTION_DEBT"; state: RetentionState; debt_days?: string[] };

export const DEFAULT_RETENTION_POLICY: Readonly<RetentionPolicy> = Object.freeze({
  raw_days: 180,
  candidate_days: 180,
  quarantine_days: 30,
  daily_rollup_years: 2,
  plan_ttl_ms: 10 * 60 * 1_000,
});

const EMPTY_REMOVALS = (): RetentionRemovalSet => ({
  event_ids: [], score_ids: [], candidate_ids: [], approval_ids: [], daily_rollup_ids: [],
  weekly_rollup_ids: [], quarantine_ids: [],
});

function beforeOrAt(timestamp: string, cutoff: number): boolean {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && value <= cutoff;
}

function subtractDays(now: Date, days: number): number {
  return now.getTime() - days * 24 * 60 * 60 * 1_000;
}

function subtractYears(now: Date, years: number): number {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return cutoff.getTime();
}

function mondayFor(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10);
}

function withDigest<T extends Omit<PlanBase, "plan_digest">>(plan: T): T & { plan_digest: string } {
  return Object.freeze({ ...plan, plan_digest: sha256Digest(plan) });
}

export function retentionStateDigest(state: RetentionState): string {
  const stableState = {
    events: [...state.events].sort((a, b) => a.event_id.localeCompare(b.event_id)),
    scores: [...state.scores].sort((a, b) => a.score_id.localeCompare(b.score_id)),
    candidates: [...state.candidates].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id)),
    approvals: [...state.approvals].sort((a, b) => a.approval_id.localeCompare(b.approval_id)),
    daily_rollups: [...state.daily_rollups].sort((a, b) => a.rollup_id.localeCompare(b.rollup_id)),
    weekly_rollups: [...state.weekly_rollups].sort((a, b) => a.rollup_id.localeCompare(b.rollup_id)),
    quarantine: [...state.quarantine].sort((a, b) => a.quarantine_id.localeCompare(b.quarantine_id)),
  };
  return sha256Digest(stableState);
}

export function createRetentionPlan(
  state: RetentionState,
  nowValue: string | Date = new Date(),
  policyValue: Partial<RetentionPolicy> = {},
): AutomaticRetentionPlan {
  const now = new Date(nowValue);
  const policy = { ...DEFAULT_RETENTION_POLICY, ...policyValue };
  const rawCutoff = subtractDays(now, policy.raw_days);
  const candidateCutoff = subtractDays(now, policy.candidate_days);
  const invocationAnchors = new Map(state.events
    .filter((event) => event.event_type === "invoked")
    .map((event) => [event.invocation_id, event.timestamp]));
  const expiredInvocationIds = new Set([...invocationAnchors]
    .filter(([, timestamp]) => beforeOrAt(timestamp, rawCutoff))
    .map(([invocationId]) => invocationId));
  const expiredStandaloneEventIds = new Set(state.events
    .filter((event) => event.event_type === "eligible" && beforeOrAt(event.timestamp, rawCutoff))
    .map((event) => event.event_id));
  const expiredCandidateIds = new Set(state.candidates
    .filter((candidate) => beforeOrAt(candidate.timestamp, candidateCutoff))
    .map((candidate) => candidate.candidate_id));
  const remove: RetentionRemovalSet = {
    event_ids: state.events.filter((event) => expiredInvocationIds.has(event.invocation_id) || expiredStandaloneEventIds.has(event.event_id)).map((event) => event.event_id).sort(),
    score_ids: state.scores.filter((score) => expiredInvocationIds.has(score.invocation_id)).map((score) => score.score_id).sort(),
    candidate_ids: [...expiredCandidateIds].sort(),
    approval_ids: state.approvals.filter((approval) => expiredCandidateIds.has(approval.candidate_id)).map((approval) => approval.approval_id).sort(),
    daily_rollup_ids: state.daily_rollups.filter((rollup) => beforeOrAt(rollup.period_start, subtractYears(now, policy.daily_rollup_years))).map((rollup) => rollup.rollup_id).sort(),
    weekly_rollup_ids: [],
    quarantine_ids: state.quarantine.filter((record) => beforeOrAt(record.timestamp, subtractDays(now, policy.quarantine_days))).map((record) => record.quarantine_id).sort(),
  };
  const compactDays = [...new Set(state.events
    .filter((event) => remove.event_ids.includes(event.event_id))
    .map((event) => (invocationAnchors.get(event.invocation_id) ?? event.timestamp).slice(0, 10)))].sort();
  const plan = {
    schema_version: 1 as const,
    kind: "automatic-retention" as const,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + policy.plan_ttl_ms).toISOString(),
    current_state_digest: retentionStateDigest(state),
    remove,
    compact_days: compactDays,
    affected_weeks: [...new Set(compactDays.map(mondayFor))].sort(),
    history_rebuildable: true,
    policy,
  };
  return withDigest(plan);
}

function inRange(timestamp: string, from: string, through: string): boolean {
  const day = timestamp.slice(0, 10);
  return day >= from && day <= through;
}

export function createPurgePlan(
  state: RetentionState,
  selection: { classes: readonly (PurgeClass | "all")[]; from: string; through: string },
  nowValue: string | Date = new Date(),
  planTtlMs = DEFAULT_RETENTION_POLICY.plan_ttl_ms,
): ExplicitPurgePlan {
  const now = new Date(nowValue);
  const classes = selection.classes.includes("all")
    ? (["raw", "candidates", "daily-rollups", "weekly-rollups", "quarantine"] satisfies PurgeClass[])
    : [...new Set(selection.classes)] as PurgeClass[];
  const selected = (value: PurgeClass) => classes.includes(value);
  const remove = EMPTY_REMOVALS();
  if (selected("raw")) {
    const invocationIds = new Set(state.events.filter((event) => inRange(event.timestamp, selection.from, selection.through)).map((event) => event.invocation_id));
    remove.event_ids = state.events.filter((event) => invocationIds.has(event.invocation_id)).map((event) => event.event_id).sort();
    remove.score_ids = state.scores.filter((score) => invocationIds.has(score.invocation_id)).map((score) => score.score_id).sort();
  }
  if (selected("candidates")) {
    const candidateIds = new Set(state.candidates.filter((candidate) => inRange(candidate.timestamp, selection.from, selection.through)).map((candidate) => candidate.candidate_id));
    remove.candidate_ids = [...candidateIds].sort();
    remove.approval_ids = state.approvals.filter((approval) => candidateIds.has(approval.candidate_id)).map((approval) => approval.approval_id).sort();
  }
  if (selected("daily-rollups")) remove.daily_rollup_ids = state.daily_rollups.filter((rollup) => inRange(rollup.period_start, selection.from, selection.through)).map((rollup) => rollup.rollup_id).sort();
  if (selected("weekly-rollups")) remove.weekly_rollup_ids = state.weekly_rollups.filter((rollup) => inRange(rollup.period_start, selection.from, selection.through)).map((rollup) => rollup.rollup_id).sort();
  if (selected("quarantine")) remove.quarantine_ids = state.quarantine.filter((record) => inRange(record.timestamp, selection.from, selection.through)).map((record) => record.quarantine_id).sort();
  return withDigest({
    schema_version: 1, kind: "explicit-purge", created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + planTtlMs).toISOString(), current_state_digest: retentionStateDigest(state),
    remove, compact_days: [], affected_weeks: [], history_rebuildable: false,
    selection: { classes: [...classes].sort(), from: selection.from, through: selection.through },
  });
}

function removePlanned(state: RetentionState, remove: RetentionRemovalSet): RetentionState {
  const omitted = <T>(values: T[], ids: readonly string[], identity: (value: T) => string) => {
    const idSet = new Set(ids);
    return values.filter((value) => !idSet.has(identity(value)));
  };
  return {
    events: omitted(state.events, remove.event_ids, (value) => value.event_id),
    scores: omitted(state.scores, remove.score_ids, (value) => value.score_id),
    candidates: omitted(state.candidates, remove.candidate_ids, (value) => value.candidate_id),
    approvals: omitted(state.approvals, remove.approval_ids, (value) => value.approval_id),
    daily_rollups: omitted(state.daily_rollups, remove.daily_rollup_ids, (value) => value.rollup_id),
    weekly_rollups: omitted(state.weekly_rollups, remove.weekly_rollup_ids, (value) => value.rollup_id),
    quarantine: omitted(state.quarantine, remove.quarantine_ids, (value) => value.quarantine_id),
  };
}

export async function applyRetentionPlan(
  plan: RetentionPlan,
  state: RetentionState,
  dependencies: RetentionApplyDependencies,
): Promise<RetentionApplyResult> {
  if (!verifyRetentionPlanDigest(plan)) return { applied: false, reason: "PLAN_DIGEST_INVALID", state };
  if (dependencies.now().getTime() > Date.parse(plan.expires_at)) return { applied: false, reason: "PLAN_EXPIRED", state };
  if (retentionStateDigest(state) !== plan.current_state_digest) return { applied: false, reason: "STALE_STATE", state };
  return dependencies.withMutationLock(async () => {
    if (retentionStateDigest(state) !== plan.current_state_digest) return { applied: false, reason: "STALE_STATE", state };
    if (plan.kind === "automatic-retention") {
      const debt = [];
      for (const date of plan.compact_days) if (!await dependencies.sealAndVerifyDaily(date)) debt.push(date);
      if (debt.length === 0) {
        for (const week of plan.affected_weeks) if (!await dependencies.recomputeWeekly(week)) debt.push(week);
      }
      if (debt.length > 0) return { applied: false, reason: "RETENTION_DEBT", state, debt_days: debt };
    }
    return { applied: true, reason: null, state: removePlanned(state, plan.remove), removed: plan.remove, history_rebuildable: plan.history_rebuildable };
  });
}

export function verifyRetentionPlanDigest(plan: RetentionPlan): boolean {
  const { plan_digest: digest, ...unsigned } = plan;
  return digest === sha256Digest(unsigned) && canonicalJson(plan).length > 0;
}

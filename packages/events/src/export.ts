import { sha256Digest } from "./canonical.ts";
import { retentionStateDigest, type RetentionState } from "./retention.ts";
import type { SkillEvent, SkillScore } from "./types.ts";

export interface ExportApprovalRequired {
  status: "NEEDS_APPROVAL";
  mode: "raw";
  approval_class: "content-free-raw-export";
  message: "Raw content-free event export requires a second explicit choice";
  preview: {
    event_count: number;
    score_count: number;
    omitted_record_classes: ["eval-candidates", "candidate-approvals", "quarantine"];
  };
}

export interface ExportPlan {
  schema_version: 1;
  status: "READY";
  mode: "aggregate" | "raw";
  created_at: string;
  expires_at: string;
  current_state_digest: string;
  aggregation_policy: "rollups-v1" | "content-free-raw-v1";
  record_counts: { daily_rollups: number; weekly_rollups: number; events: number; scores: number };
  omitted_record_classes: ["eval-candidates", "candidate-approvals", "quarantine"];
  plan_digest: string;
}

export interface ExportBundle {
  schema_version: 1;
  exported_at: string;
  export_plan_digest: string;
  aggregation_policy: ExportPlan["aggregation_policy"];
  rollups?: { daily: RetentionState["daily_rollups"]; weekly: RetentionState["weekly_rollups"] };
  raw?: { events: Array<Record<string, unknown>>; scores: Array<Record<string, unknown>> };
}

export type ExportApplyResult = { ok: true; value: ExportBundle } | { ok: false; reason: "PLAN_EXPIRED" | "STALE_STATE" | "PLAN_DIGEST_INVALID" };

interface AggregateExportOptions { mode?: "aggregate"; confirm_content_free_raw?: never; plan_ttl_ms?: number }
interface RawExportOptions { mode: "raw"; confirm_content_free_raw?: boolean; plan_ttl_ms?: number }

export function createExportPlan(state: RetentionState, options?: AggregateExportOptions, nowValue?: string | Date): ExportPlan;
export function createExportPlan(state: RetentionState, options: RawExportOptions, nowValue?: string | Date): ExportPlan | ExportApprovalRequired;
export function createExportPlan(
  state: RetentionState,
  options: AggregateExportOptions | RawExportOptions = {},
  nowValue: string | Date = new Date(),
): ExportPlan | ExportApprovalRequired {
  const mode = options.mode ?? "aggregate";
  if (mode === "raw" && options.confirm_content_free_raw !== true) {
    return Object.freeze({
      status: "NEEDS_APPROVAL",
      mode: "raw",
      approval_class: "content-free-raw-export",
      message: "Raw content-free event export requires a second explicit choice",
      preview: {
        event_count: state.events.length,
        score_count: state.scores.length,
        omitted_record_classes: ["eval-candidates", "candidate-approvals", "quarantine"] as ["eval-candidates", "candidate-approvals", "quarantine"],
      },
    });
  }
  const now = new Date(nowValue);
  const unsigned = {
    schema_version: 1 as const,
    status: "READY" as const,
    mode,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (options.plan_ttl_ms ?? 10 * 60 * 1_000)).toISOString(),
    current_state_digest: retentionStateDigest(state),
    aggregation_policy: mode === "aggregate" ? "rollups-v1" as const : "content-free-raw-v1" as const,
    record_counts: {
      daily_rollups: state.daily_rollups.length,
      weekly_rollups: state.weekly_rollups.length,
      events: mode === "raw" ? state.events.length : 0,
      scores: mode === "raw" ? state.scores.length : 0,
    },
    omitted_record_classes: ["eval-candidates", "candidate-approvals", "quarantine"] as ["eval-candidates", "candidate-approvals", "quarantine"],
  };
  return Object.freeze({ ...unsigned, plan_digest: sha256Digest(unsigned) });
}

function cohortMap(events: readonly SkillEvent[], scores: readonly SkillScore[]): Map<string, string> {
  const invocationIds = [...new Set([...events.map((event) => event.invocation_id), ...scores.map((score) => score.invocation_id)])].sort();
  return new Map(invocationIds.map((invocationId, index) => [invocationId, `cohort-${String(index + 1).padStart(6, "0")}`]));
}

function sanitizeEvent(event: SkillEvent, cohorts: ReadonlyMap<string, string>): Record<string, unknown> {
  const {
    event_id: _eventId,
    invocation_id: invocationId,
    session_id: _sessionId,
    route_id: _routeId,
    source_aliases: _sourceAliases,
    ...contentFree
  } = event;
  void _eventId; void _sessionId; void _routeId; void _sourceAliases;
  return { ...contentFree, cohort_id: cohorts.get(invocationId)! };
}

function sanitizeScore(score: SkillScore, cohorts: ReadonlyMap<string, string>): Record<string, unknown> {
  const {
    score_id: _scoreId,
    invocation_id: invocationId,
    evidence_digests: _evidenceDigests,
    supersedes_score_id: _supersedesScoreId,
    ...contentFree
  } = score;
  void _scoreId; void _evidenceDigests; void _supersedesScoreId;
  return { ...contentFree, cohort_id: cohorts.get(invocationId)! };
}

export function applyExportPlan(
  plan: ExportPlan,
  state: RetentionState,
  nowValue: string | Date = new Date(),
): ExportApplyResult {
  const { plan_digest: digest, ...unsigned } = plan;
  if (digest !== sha256Digest(unsigned)) return { ok: false, reason: "PLAN_DIGEST_INVALID" };
  if (new Date(nowValue).getTime() > Date.parse(plan.expires_at)) return { ok: false, reason: "PLAN_EXPIRED" };
  if (retentionStateDigest(state) !== plan.current_state_digest) return { ok: false, reason: "STALE_STATE" };
  const base = {
    schema_version: 1 as const,
    exported_at: new Date(nowValue).toISOString(),
    export_plan_digest: plan.plan_digest,
    aggregation_policy: plan.aggregation_policy,
  };
  if (plan.mode === "aggregate") {
    return { ok: true, value: { ...base, rollups: { daily: structuredClone(state.daily_rollups), weekly: structuredClone(state.weekly_rollups) } } };
  }
  const cohorts = cohortMap(state.events, state.scores);
  return {
    ok: true,
    value: {
      ...base,
      raw: {
        events: state.events.map((event) => sanitizeEvent(event, cohorts)),
        scores: state.scores.map((score) => sanitizeScore(score, cohorts)),
      },
    },
  };
}

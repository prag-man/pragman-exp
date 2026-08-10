import { sha256Digest } from "./canonical.ts";
import type { EvalCandidate, EvalCandidateApproval, SkillEvent, SkillScore } from "./types.ts";

export type LifecycleReason =
  | "APPROVAL_ID_COLLISION"
  | "ARTIFACT_DIGEST_MISMATCH"
  | "CANDIDATE_ALREADY_DECIDED"
  | "CANDIDATE_DIGEST_MISMATCH"
  | "CANDIDATE_ID_COLLISION"
  | "EVENT_ID_COLLISION"
  | "EVENT_IDENTITY_MISMATCH"
  | "EVENT_TIMESTAMP_NOT_LATER"
  | "INVOCATION_ALREADY_STARTED"
  | "MISSING_SCORE_PREDECESSOR"
  | "SCORE_CYCLE"
  | "SCORE_FORK"
  | "SCORE_ID_COLLISION"
  | "SCORE_IDENTITY_MISMATCH"
  | "SCORE_PREDECESSOR_NOT_EARLIER"
  | "SCORE_TIMESTAMP_PRECEDES_INVOCATION"
  | "TERMINAL_EVENT_EXISTS"
  | "UNKNOWN_CANDIDATE"
  | "UNKNOWN_INVOCATION"
  | "UNKNOWN_SCORE_INVOCATION"
  | "VERIFICATION_BEFORE_TERMINAL"
  | "VERIFICATION_EXISTS";

export type LifecycleMutationResult =
  | { ok: true; status: "accepted" | "duplicate" }
  | { ok: false; reason: LifecycleReason };

export interface InvocationLifecycle {
  invocation_id: string;
  state: "invoked" | "completed" | "cancelled" | "verified";
  terminal_event_type: "completed" | "cancelled" | null;
  verified: boolean;
  verification_outcome: string | null;
  incomplete: boolean;
  retention_anchor: string;
}

interface InvocationEntry {
  invoked: SkillEvent;
  terminal?: SkillEvent;
  verified?: SkillEvent;
}

const EVENT_IDENTITY_FIELDS = [
  "invocation_id",
  "skill_id",
  "skill_version",
  "skill_digest",
  "skill_type",
  "host",
  "host_version",
  "model",
  "model_version",
  "harness_version",
  "invocation_mode",
  "session_id",
  "route_id",
  "eval_id",
  "case_id",
  "trial_id",
  "provider",
  "ablation_arm",
  "trigger_expected",
  "trigger_actual",
  "provider_digest",
  "eval_corpus_digest",
  "trial_policy_digest",
  "storage_scope",
  "append_only",
] as const satisfies readonly (keyof SkillEvent)[];

const SCORE_IDENTITY_FIELDS = [
  "invocation_id",
  "metric_id",
  "metric_definition_digest",
  "value_type",
  "source",
  "grader_id",
  "grader_version",
  "rubric_digest",
] as const satisfies readonly (keyof SkillScore)[];

function matchingFields<T extends object>(
  left: T,
  right: T,
  fields: readonly (keyof T)[],
): boolean {
  return fields.every((field) => left[field] === right[field]);
}

function duplicateResult<T extends object>(
  records: Map<string, T>,
  identity: string,
  record: T,
  collisionReason: LifecycleReason,
): LifecycleMutationResult | null {
  const existing = records.get(identity);
  if (!existing) return null;
  return sha256Digest(existing) === sha256Digest(record)
    ? { ok: true, status: "duplicate" }
    : { ok: false, reason: collisionReason };
}

export interface LifecycleIndex {
  addEvent(record: SkillEvent): LifecycleMutationResult;
  addScore(record: SkillScore): LifecycleMutationResult;
  addCandidate(record: EvalCandidate): LifecycleMutationResult;
  addApproval(record: EvalCandidateApproval): LifecycleMutationResult;
  getInvocation(invocationId: string): InvocationLifecycle | undefined;
  incompleteInvocationIds(): string[];
  scoreChain(scoreId: string): SkillScore[];
  latestScore(scoreId: string): SkillScore | undefined;
  scoreRetentionAnchor(scoreId: string): string | undefined;
}

export function createLifecycleIndex(): LifecycleIndex {
  const eventIds = new Map<string, SkillEvent>();
  const invocations = new Map<string, InvocationEntry>();
  const scores = new Map<string, SkillScore>();
  const scoreSuccessors = new Map<string, string>();
  const candidates = new Map<string, EvalCandidate>();
  const approvals = new Map<string, EvalCandidateApproval>();
  const candidateDecisions = new Map<string, string>();

  function addEvent(record: SkillEvent): LifecycleMutationResult {
    const duplicate = duplicateResult(eventIds, record.event_id, record, "EVENT_ID_COLLISION");
    if (duplicate) return duplicate;

    if (record.event_type === "eligible") {
      eventIds.set(record.event_id, record);
      return { ok: true, status: "accepted" };
    }
    if (record.event_type === "invoked") {
      if (invocations.has(record.invocation_id)) return { ok: false, reason: "INVOCATION_ALREADY_STARTED" };
      eventIds.set(record.event_id, record);
      invocations.set(record.invocation_id, { invoked: record });
      return { ok: true, status: "accepted" };
    }

    const invocation = invocations.get(record.invocation_id);
    if (!invocation) return { ok: false, reason: "UNKNOWN_INVOCATION" };
    if (!matchingFields(invocation.invoked, record, EVENT_IDENTITY_FIELDS)) {
      return { ok: false, reason: "EVENT_IDENTITY_MISMATCH" };
    }

    if (record.event_type === "completed" || record.event_type === "cancelled") {
      if (invocation.terminal) return { ok: false, reason: "TERMINAL_EVENT_EXISTS" };
      if (Date.parse(record.timestamp) <= Date.parse(invocation.invoked.timestamp)) {
        return { ok: false, reason: "EVENT_TIMESTAMP_NOT_LATER" };
      }
      invocation.terminal = record;
    } else {
      if (!invocation.terminal) return { ok: false, reason: "VERIFICATION_BEFORE_TERMINAL" };
      if (invocation.verified) return { ok: false, reason: "VERIFICATION_EXISTS" };
      if (Date.parse(record.timestamp) <= Date.parse(invocation.terminal.timestamp)) {
        return { ok: false, reason: "EVENT_TIMESTAMP_NOT_LATER" };
      }
      invocation.verified = record;
    }
    eventIds.set(record.event_id, record);
    return { ok: true, status: "accepted" };
  }

  function addScore(record: SkillScore): LifecycleMutationResult {
    const duplicate = duplicateResult(scores, record.score_id, record, "SCORE_ID_COLLISION");
    if (duplicate) return duplicate;
    const invocation = invocations.get(record.invocation_id);
    if (!invocation) return { ok: false, reason: "UNKNOWN_SCORE_INVOCATION" };
    if (Date.parse(record.timestamp) < Date.parse(invocation.invoked.timestamp)) {
      return { ok: false, reason: "SCORE_TIMESTAMP_PRECEDES_INVOCATION" };
    }

    const predecessorId = record.supersedes_score_id;
    if (predecessorId !== undefined) {
      if (predecessorId === record.score_id) return { ok: false, reason: "SCORE_CYCLE" };
      const predecessor = scores.get(predecessorId);
      if (!predecessor) return { ok: false, reason: "MISSING_SCORE_PREDECESSOR" };
      if (Date.parse(predecessor.timestamp) >= Date.parse(record.timestamp)) {
        return { ok: false, reason: "SCORE_PREDECESSOR_NOT_EARLIER" };
      }
      if (!matchingFields(predecessor, record, SCORE_IDENTITY_FIELDS)) {
        return { ok: false, reason: "SCORE_IDENTITY_MISMATCH" };
      }
      if (scoreSuccessors.has(predecessorId)) return { ok: false, reason: "SCORE_FORK" };

      const visited = new Set([record.score_id]);
      let cursor: SkillScore | undefined = predecessor;
      while (cursor) {
        if (visited.has(cursor.score_id)) return { ok: false, reason: "SCORE_CYCLE" };
        visited.add(cursor.score_id);
        cursor = cursor.supersedes_score_id === undefined ? undefined : scores.get(cursor.supersedes_score_id);
      }
      scoreSuccessors.set(predecessorId, record.score_id);
    }
    scores.set(record.score_id, record);
    return { ok: true, status: "accepted" };
  }

  function addCandidate(record: EvalCandidate): LifecycleMutationResult {
    const duplicate = duplicateResult(candidates, record.candidate_id, record, "CANDIDATE_ID_COLLISION");
    if (duplicate) return duplicate;
    candidates.set(record.candidate_id, record);
    return { ok: true, status: "accepted" };
  }

  function addApproval(record: EvalCandidateApproval): LifecycleMutationResult {
    const duplicate = duplicateResult(approvals, record.approval_id, record, "APPROVAL_ID_COLLISION");
    if (duplicate) return duplicate;
    const candidate = candidates.get(record.candidate_id);
    if (!candidate) return { ok: false, reason: "UNKNOWN_CANDIDATE" };
    if (record.candidate_digest !== sha256Digest(candidate)) {
      return { ok: false, reason: "CANDIDATE_DIGEST_MISMATCH" };
    }
    if (record.reviewed_redacted_artifact_digest !== candidate.redacted_artifact_digest) {
      return { ok: false, reason: "ARTIFACT_DIGEST_MISMATCH" };
    }
    if (candidateDecisions.has(record.candidate_id)) {
      return { ok: false, reason: "CANDIDATE_ALREADY_DECIDED" };
    }
    approvals.set(record.approval_id, record);
    candidateDecisions.set(record.candidate_id, record.approval_id);
    return { ok: true, status: "accepted" };
  }

  function getInvocation(invocationId: string): InvocationLifecycle | undefined {
    const invocation = invocations.get(invocationId);
    if (!invocation) return undefined;
    const terminalType = invocation.terminal?.event_type;
    return {
      invocation_id: invocationId,
      state: invocation.verified
        ? "verified"
        : terminalType === "completed" || terminalType === "cancelled"
          ? terminalType
          : "invoked",
      terminal_event_type: terminalType === "completed" || terminalType === "cancelled" ? terminalType : null,
      verified: invocation.verified !== undefined,
      verification_outcome: invocation.verified?.outcome_code ?? null,
      incomplete: invocation.terminal === undefined,
      retention_anchor: invocation.invoked.timestamp,
    };
  }

  function scoreChain(scoreId: string): SkillScore[] {
    let cursor = scores.get(scoreId);
    if (!cursor) return [];
    while (cursor.supersedes_score_id !== undefined) {
      const predecessor = scores.get(cursor.supersedes_score_id);
      if (!predecessor) break;
      cursor = predecessor;
    }
    const chain: SkillScore[] = [cursor];
    let successorId = scoreSuccessors.get(cursor.score_id);
    while (successorId !== undefined) {
      const successor = scores.get(successorId);
      if (!successor) break;
      chain.push(successor);
      successorId = scoreSuccessors.get(successorId);
    }
    return chain;
  }

  return Object.freeze({
    addEvent,
    addScore,
    addCandidate,
    addApproval,
    getInvocation,
    incompleteInvocationIds() {
      return [...invocations.keys()]
        .filter((invocationId) => invocations.get(invocationId)?.terminal === undefined)
        .sort((left, right) => left.localeCompare(right));
    },
    scoreChain,
    latestScore(scoreId: string) {
      return scoreChain(scoreId).at(-1);
    },
    scoreRetentionAnchor(scoreId: string) {
      const record = scores.get(scoreId);
      return record === undefined ? undefined : invocations.get(record.invocation_id)?.invoked.timestamp;
    },
  });
}

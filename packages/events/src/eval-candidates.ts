import { sha256Digest } from "./canonical.ts";
import type { EvalCandidate, EvalCandidateApproval } from "./types.ts";
import { createEventValidators } from "./validation.ts";

type CandidateFixedFields = "schema_version" | "approval_status" | "storage_scope" | "append_only";
export type CreateEvalCandidateInput = Omit<EvalCandidate, CandidateFixedFields>;

export type CreateEvalCandidateDecisionInput = {
  approval_id: string;
  timestamp: string;
  candidate: EvalCandidate;
  decision: EvalCandidateApproval["decision"];
  reviewed_redacted_artifact_digest: string;
};
export type CreateEvalCandidateDecisionFields = Omit<CreateEvalCandidateDecisionInput, "candidate">;

const validators = createEventValidators();

export function createEvalCandidate(input: CreateEvalCandidateInput): EvalCandidate {
  const candidate = {
    ...input,
    schema_version: 1,
    approval_status: "pending",
    storage_scope: "local",
    append_only: true,
  } satisfies EvalCandidate;
  const validation = validators.candidate(candidate);
  if (!validation.ok) throw new TypeError(validation.code);
  return Object.freeze(structuredClone(validation.value));
}

export function createEvalCandidateDecision(input: CreateEvalCandidateDecisionInput): EvalCandidateApproval;
export function createEvalCandidateDecision(candidate: EvalCandidate, input: CreateEvalCandidateDecisionFields): EvalCandidateApproval;
export function createEvalCandidateDecision(
  inputOrCandidate: CreateEvalCandidateDecisionInput | EvalCandidate,
  fields?: CreateEvalCandidateDecisionFields,
): EvalCandidateApproval {
  const input: CreateEvalCandidateDecisionInput = fields === undefined
    ? inputOrCandidate as CreateEvalCandidateDecisionInput
    : { ...fields, candidate: inputOrCandidate as EvalCandidate };
  const approval = {
    schema_version: 1,
    approval_id: input.approval_id,
    timestamp: input.timestamp,
    candidate_id: input.candidate.candidate_id,
    candidate_digest: sha256Digest(input.candidate),
    decision: input.decision,
    approval_source: "user",
    reviewed_redacted_artifact_digest: input.reviewed_redacted_artifact_digest,
    storage_scope: "local",
    append_only: true,
  } satisfies EvalCandidateApproval;
  const validation = validators.approval(approval);
  if (!validation.ok) throw new TypeError(validation.code);
  return Object.freeze(structuredClone(validation.value));
}

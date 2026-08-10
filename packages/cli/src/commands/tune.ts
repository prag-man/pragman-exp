import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWrite, contentDigest, normalizeAbsolutePath, resolveContainedPath } from "../../../config/src/index.ts";
import { canonicalJson, sha256Digest, type EvalCandidate, type EvalCandidateApproval } from "../../../events/src/index.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution, CommandIo } from "./events.ts";
import { DEFAULT_EVENT_STATE_ROOT, loadRetentionState } from "./events.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECRET = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/;

interface TuneInput {
  candidate_id: string;
  candidate_digest: string;
  scenario: { scenario_id: string; failure_codes: string[]; acceptance_invariants: string[] };
  evaluation: { status: "COMPARABLE"; passed: true; candidate_digest: string; skill_digest: string; evidence_digest: string };
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function failure(error: unknown): CommandExecution {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "INTERNAL";
  const message = error instanceof Error ? error.message : "Tune failed";
  const exitCode = code === "NEEDS_INPUT" ? EXIT_CODES.needsInput : code === "STALE_PREVIEW" || code === "PRIVACY_DENIED" || code === "EVALUATION_FAILED" ? EXIT_CODES.denied
    : code === "INTERNAL" ? EXIT_CODES.internal : EXIT_CODES.invalid;
  return { exitCode, envelope: errorEnvelope("tune", code, message), human: message, stderr: true };
}

async function readInput(arguments_: CliArguments, io: CommandIo): Promise<TuneInput> {
  const raw = arguments_.file ? await readFile(arguments_.file, "utf8") : await io.readStdin();
  if (!raw.trim()) throw Object.assign(new Error("Approved candidate and evaluation JSON are required"), { code: "NEEDS_INPUT" });
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw Object.assign(new Error("Tune input must be valid JSON"), { code: "INVALID_INPUT" }); }
  if (!object(value) || Object.keys(value).sort().join(",") !== "candidate_digest,candidate_id,evaluation,scenario" || !object(value.scenario) || !object(value.evaluation)) {
    throw Object.assign(new Error("Tune input fields are invalid"), { code: "INVALID_INPUT" });
  }
  const scenario = value.scenario;
  const evaluation = value.evaluation;
  const arrays = Array.isArray(scenario.failure_codes) && scenario.failure_codes.every((entry) => typeof entry === "string" && SLUG.test(entry))
    && Array.isArray(scenario.acceptance_invariants) && scenario.acceptance_invariants.length > 0 && scenario.acceptance_invariants.length <= 16
    && scenario.acceptance_invariants.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 200 && !SECRET.test(entry));
  if (typeof value.candidate_id !== "string" || typeof value.candidate_digest !== "string" || !SHA256.test(value.candidate_digest)
    || typeof scenario.scenario_id !== "string" || !SLUG.test(scenario.scenario_id) || !arrays
    || evaluation.status !== "COMPARABLE" || evaluation.passed !== true || ![evaluation.candidate_digest, evaluation.skill_digest, evaluation.evidence_digest].every((entry) => typeof entry === "string" && SHA256.test(entry))) {
    throw Object.assign(new Error("Tune candidate, scenario, or evaluation evidence is invalid"), { code: "INVALID_INPUT" });
  }
  if (evaluation.candidate_digest !== value.candidate_digest) throw Object.assign(new Error("Evaluation is not bound to the selected candidate"), { code: "EVALUATION_FAILED" });
  return value as unknown as TuneInput;
}

function approvedCandidate(candidates: EvalCandidate[], approvals: EvalCandidateApproval[], input: TuneInput): EvalCandidate {
  const candidate = candidates.find((entry) => entry.candidate_id === input.candidate_id);
  if (!candidate) throw Object.assign(new Error("Evaluation candidate does not exist"), { code: "UNKNOWN_CANDIDATE" });
  const candidateDigest = sha256Digest(candidate);
  if (candidateDigest !== input.candidate_digest) throw Object.assign(new Error("Candidate digest does not match"), { code: "STALE_PREVIEW" });
  const approval = [...approvals].reverse().find((entry) => entry.candidate_id === candidate.candidate_id && entry.candidate_digest === candidateDigest);
  if (!approval || approval.decision !== "approved" || approval.reviewed_redacted_artifact_digest !== candidate.redacted_artifact_digest) {
    throw Object.assign(new Error("Candidate needs an explicit approval bound to the reviewed redacted artifact"), { code: "NEEDS_INPUT" });
  }
  if (input.evaluation.skill_digest !== candidate.skill_digest) throw Object.assign(new Error("Evaluation skill digest does not match the candidate"), { code: "EVALUATION_FAILED" });
  if (input.scenario.failure_codes.some((code) => !candidate.failure_codes.includes(code))) throw Object.assign(new Error("Scenario introduces an unapproved failure class"), { code: "PRIVACY_DENIED" });
  return candidate;
}

async function withLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(root, ".tune-lock");
  try { await mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("Another tuning writer is active"), { code: "TEMPORARY_FAILURE" });
    throw error;
  }
  try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
}

export async function executeTuneCommand(arguments_: CliArguments, io: CommandIo): Promise<CommandExecution> {
  try {
    const input = await readInput(arguments_, io);
    const state = await loadRetentionState(arguments_.stateRoot ?? DEFAULT_EVENT_STATE_ROOT);
    const candidate = approvedCandidate(state.candidates, state.approvals, input);
    const root = normalizeAbsolutePath(arguments_.config ?? join(homedir(), ".pragman"));
    const skillAlias = candidate.skill_id.replaceAll(":", "--");
    if (!/^[a-z0-9-]+$/.test(skillAlias)) throw Object.assign(new Error("Skill identity is unsafe for an overlay"), { code: "PRIVACY_DENIED" });
    const target = resolveContainedPath(root, join(root, "overlays", skillAlias, "eval-candidates.jsonl"));
    let current = "";
    try { current = await readFile(target, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const entry = {
      schema_version: 1,
      candidate_id: candidate.candidate_id,
      candidate_digest: input.candidate_digest,
      skill_id: candidate.skill_id,
      skill_digest: candidate.skill_digest,
      scenario: input.scenario,
      evaluation_evidence_digest: input.evaluation.evidence_digest,
      approval_status: "approved",
    };
    if (current.split("\n").filter(Boolean).some((line) => (JSON.parse(line) as { candidate_id?: string }).candidate_id === candidate.candidate_id)) {
      throw Object.assign(new Error("Candidate already exists in this private overlay"), { code: "STALE_PREVIEW" });
    }
    const next = `${current}${canonicalJson(entry)}\n`;
    const previewDigest = contentDigest(next);
    const preview = {
      mutated: false, target_alias: `private-overlay:${skillAlias}`, candidate_id: candidate.candidate_id,
      candidate_digest: input.candidate_digest, scenario: input.scenario, evaluation: { status: "COMPARABLE", passed: true, evidence_digest: input.evaluation.evidence_digest },
      base_digest: contentDigest(current), preview_digest: previewDigest, approval_classes: ["private-overlay-write"],
    };
    if (!arguments_.applyDigest) return { exitCode: EXIT_CODES.success, envelope: successEnvelope("tune", preview), human: `Tuning preview ${previewDigest}; a second approval is required.`, stderr: false };
    if (arguments_.applyDigest !== previewDigest) throw Object.assign(new Error("Tune preview digest is stale"), { code: "STALE_PREVIEW" });
    await withLock(root, async () => {
      let latest = "";
      try { latest = await readFile(target, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (contentDigest(latest) !== preview.base_digest) throw Object.assign(new Error("Private overlay changed after preview"), { code: "STALE_PREVIEW" });
      await atomicWrite(target, next);
    });
    return { exitCode: EXIT_CODES.success, envelope: successEnvelope("tune", { ...preview, mutated: true }), human: `Applied approved candidate ${candidate.candidate_id} to a private overlay.`, stderr: false };
  } catch (error) {
    return failure(error);
  }
}

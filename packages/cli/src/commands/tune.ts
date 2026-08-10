import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWrite, contentDigest, normalizeAbsolutePath, resolveContainedPath } from "../../../config/src/index.ts";
import { canonicalJson, sha256Digest, type EvalCandidate, type EvalCandidateApproval } from "../../../events/src/index.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution, CommandIo } from "./events.ts";
import { DEFAULT_EVENT_STATE_ROOT, loadRetentionState } from "./events.ts";
import { loadEvalEvidenceArtifact, type EvalEvidenceArtifact } from "./eval.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVIDENCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECRET = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/;
const MAX_TUNE_JOURNAL_BYTES = 10 * 1024 * 1024;
const MAX_TUNE_RECORDS = 10_000;

interface TuneInput {
  candidate_id: string;
  candidate_digest: string;
  scenario: { scenario_id: string; failure_codes: string[]; acceptance_invariants: string[] };
  evaluation: { evidence_id: string; artifact_digest: string };
}

interface VerifiedEvaluation {
  artifact: EvalEvidenceArtifact;
  artifactDigest: string;
  comparisonSkillDigest: string;
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function failure(error: unknown): CommandExecution {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "INTERNAL";
  const message = error instanceof Error ? error.message : "Tune failed";
  const exitCode = code === "NEEDS_INPUT" ? EXIT_CODES.needsInput
    : code === "STALE_PREVIEW" || code === "PRIVACY_DENIED" || code === "EVALUATION_FAILED" ? EXIT_CODES.denied
      : code === "TEMPORARY_FAILURE" ? EXIT_CODES.temporary
      : code === "INTERNAL" ? EXIT_CODES.internal : EXIT_CODES.invalid;
  return { exitCode, envelope: errorEnvelope("tune", code, message, null, code === "TEMPORARY_FAILURE"), human: message, stderr: true };
}

async function readInput(arguments_: CliArguments, io: CommandIo): Promise<TuneInput> {
  const raw = arguments_.file ? await readFile(arguments_.file, "utf8") : await io.readStdin();
  if (!raw.trim()) throw Object.assign(new Error("Approved candidate and evaluation JSON are required"), { code: "NEEDS_INPUT" });
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw Object.assign(new Error("Tune input must be valid JSON"), { code: "INVALID_INPUT" }); }
  if (!object(value) || !exactKeys(value, ["candidate_id", "candidate_digest", "scenario", "evaluation"])
    || !object(value.scenario) || !exactKeys(value.scenario, ["scenario_id", "failure_codes", "acceptance_invariants"])
    || !object(value.evaluation) || !exactKeys(value.evaluation, ["evidence_id", "artifact_digest"])) {
    throw Object.assign(new Error("Tune input fields are invalid"), { code: "INVALID_INPUT" });
  }
  const scenario = value.scenario;
  const evaluation = value.evaluation;
  const arrays = Array.isArray(scenario.failure_codes) && scenario.failure_codes.every((entry) => typeof entry === "string" && SLUG.test(entry))
    && Array.isArray(scenario.acceptance_invariants) && scenario.acceptance_invariants.length > 0 && scenario.acceptance_invariants.length <= 16
    && scenario.acceptance_invariants.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 200 && !SECRET.test(entry));
  if (typeof value.candidate_id !== "string" || value.candidate_id.length < 1 || value.candidate_id.length > 128
    || typeof value.candidate_digest !== "string" || !SHA256.test(value.candidate_digest)
    || typeof scenario.scenario_id !== "string" || !SLUG.test(scenario.scenario_id) || !arrays
    || typeof evaluation.evidence_id !== "string" || evaluation.evidence_id.length > 96 || !EVIDENCE_ID.test(evaluation.evidence_id)
    || typeof evaluation.artifact_digest !== "string" || !SHA256.test(evaluation.artifact_digest)) {
    throw Object.assign(new Error("Tune candidate, scenario, or evaluation evidence is invalid"), { code: "INVALID_INPUT" });
  }
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
  if (input.scenario.failure_codes.some((code) => !candidate.failure_codes.includes(code))) {
    throw Object.assign(new Error("Scenario introduces an unapproved failure class"), { code: "PRIVACY_DENIED" });
  }
  return candidate;
}

function verifyEvaluation(
  loaded: { artifact: EvalEvidenceArtifact; artifactDigest: string },
  input: TuneInput,
  candidate: EvalCandidate,
): VerifiedEvaluation {
  const { artifact, artifactDigest } = loaded;
  if (artifactDigest !== input.evaluation.artifact_digest || artifact.candidate_digest !== input.candidate_digest) {
    throw Object.assign(new Error("Evaluation artifact is not bound to the approved candidate"), { code: "EVALUATION_FAILED" });
  }
  const evidence = artifact.evidence;
  if (evidence.status !== "COMPARABLE" || !object(evidence.comparison_identity)
    || evidence.comparison_identity.skill_digest !== candidate.skill_digest) {
    throw Object.assign(new Error("Evaluation does not compare the approved skill digest"), { code: "EVALUATION_FAILED" });
  }
  const onPassRate = evidence.skill_on_pass_rate;
  const offPassRate = evidence.skill_off_pass_rate;
  const utilityLift = evidence.utility_lift;
  const verifiedLift = evidence.verified_success_lift;
  if (typeof onPassRate !== "number" || typeof offPassRate !== "number" || onPassRate < offPassRate
    || typeof utilityLift !== "number" || utilityLift < 0
    || typeof verifiedLift !== "number" || verifiedLift < 0
    || !object(evidence.trials_per_case) || !(input.scenario.scenario_id in evidence.trials_per_case)
    || !Array.isArray(evidence.pairs)) {
    throw Object.assign(new Error("Evaluation did not meet non-regression thresholds"), { code: "EVALUATION_FAILED" });
  }
  const scenarioPairs = evidence.pairs.filter((pair) => object(pair) && pair.case_id === input.scenario.scenario_id);
  const expectedPairCount = evidence.trials_per_case[input.scenario.scenario_id];
  if (typeof expectedPairCount !== "number" || scenarioPairs.length !== expectedPairCount || scenarioPairs.length === 0
    || !scenarioPairs.every((pair) => {
      if (!object(pair) || !object(pair.skill_on) || !object(pair.skill_off)) return false;
      return pair.skill_on.passed === true && pair.skill_on.verified_success === true
        && typeof pair.skill_on.utility === "number" && typeof pair.skill_off.utility === "number"
        && pair.skill_on.utility >= pair.skill_off.utility;
    })) {
    throw Object.assign(new Error("Selected scenario lacks passing non-regressive evidence"), { code: "EVALUATION_FAILED" });
  }
  return { artifact, artifactDigest, comparisonSkillDigest: String(evidence.comparison_identity.skill_digest) };
}

async function ensureRegularDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw Object.assign(new Error("Private overlay directory is unsafe"), { code: "PRIVACY_DENIED" });
  }
}

async function assertRegularDirectoryIfPresent(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw Object.assign(new Error("Private overlay directory is unsafe"), { code: "PRIVACY_DENIED" });
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readRegularFile(path: string): Promise<{ bytes: string; existed: boolean }> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw Object.assign(new Error("Private overlay target is unsafe"), { code: "PRIVACY_DENIED" });
    return { bytes: await readFile(path, "utf8"), existed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: "", existed: false };
    throw error;
  }
}

async function withLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  await ensureRegularDirectory(root);
  const lock = join(root, ".tune-lock");
  try { await mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("Another tuning writer is active"), { code: "TEMPORARY_FAILURE" });
    throw error;
  }
  try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
}

async function preserveSnapshot(root: string, digest: string, bytes: string): Promise<string> {
  const history = resolveContainedPath(root, join(root, "history"));
  const snapshots = resolveContainedPath(root, join(history, "snapshots"));
  await ensureRegularDirectory(history);
  await ensureRegularDirectory(snapshots);
  const path = resolveContainedPath(root, join(snapshots, `${digest}.bin`));
  const existing = await readRegularFile(path);
  if (existing.existed) {
    if (contentDigest(existing.bytes) !== digest) throw Object.assign(new Error("Existing tuning snapshot failed its digest check"), { code: "PRIVACY_DENIED" });
  } else {
    await atomicWrite(path, bytes);
  }
  return path;
}

async function appendTuneJournal(root: string, record: Record<string, unknown>): Promise<void> {
  const history = resolveContainedPath(root, join(root, "history"));
  await ensureRegularDirectory(history);
  const path = resolveContainedPath(root, join(history, "tune-changes.jsonl"));
  const current = await readRegularFile(path);
  await atomicWrite(path, `${current.bytes}${canonicalJson(record)}\n`);
}

export async function listTuneChanges(personalRoot: string): Promise<Record<string, unknown>[]> {
  const root = normalizeAbsolutePath(personalRoot);
  const path = resolveContainedPath(root, join(root, "history", "tune-changes.jsonl"));
  const current = await readRegularFile(path);
  if (Buffer.byteLength(current.bytes) > MAX_TUNE_JOURNAL_BYTES) {
    throw Object.assign(new Error("Tune change journal exceeds the bounded read limit"), { code: "PRIVACY_DENIED" });
  }
  const lines = current.bytes.split("\n").filter(Boolean);
  if (lines.length > MAX_TUNE_RECORDS) {
    throw Object.assign(new Error("Tune change journal exceeds the record limit"), { code: "PRIVACY_DENIED" });
  }
  try {
    return lines.map((line) => {
      const value = JSON.parse(line) as unknown;
      if (!object(value)) throw new TypeError("invalid-record");
      return value;
    });
  } catch {
    throw Object.assign(new Error("Tune change journal is invalid"), { code: "PRIVACY_DENIED" });
  }
}

export async function rollbackTuneChange(options: {
  personalRoot: string;
  changeId: string;
  applyDigest?: string;
}): Promise<Record<string, unknown>> {
  const root = normalizeAbsolutePath(options.personalRoot);
  const records = await listTuneChanges(root);
  const applied = records.find((record) => record.change_id === options.changeId && record.record_type === "tune-apply");
  if (!applied || typeof applied.target_alias !== "string" || typeof applied.preview_digest !== "string"
    || typeof applied.base_digest !== "string" || typeof applied.base_existed !== "boolean"
    || !object(applied.rollback) || applied.rollback.snapshot_ref !== applied.base_digest) {
    throw Object.assign(new Error("Tune change record was not found or is invalid"), { code: "NOT_FOUND" });
  }
  if (records.some((record) => record.record_type === "tune-rollback" && record.rolled_back_change_id === options.changeId)) {
    throw Object.assign(new Error("Tune change has already been rolled back"), { code: "STALE_PREVIEW" });
  }
  const skillAlias = applied.target_alias.slice("private-overlay:".length);
  if (!applied.target_alias.startsWith("private-overlay:") || !/^[a-z0-9-]+$/.test(skillAlias)) {
    throw Object.assign(new Error("Tune change target is unsafe"), { code: "PRIVACY_DENIED" });
  }
  const target = resolveContainedPath(root, join(root, "overlays", skillAlias, "eval-candidates.jsonl"));
  const current = await readRegularFile(target);
  const snapshotPath = resolveContainedPath(root, join(root, "history", "snapshots", `${applied.base_digest}.bin`));
  const snapshot = await readRegularFile(snapshotPath);
  if (!current.existed || contentDigest(current.bytes) !== applied.preview_digest
    || !snapshot.existed || contentDigest(snapshot.bytes) !== applied.base_digest) {
    throw Object.assign(new Error("Tune overlay or rollback snapshot changed after application"), { code: "STALE_PREVIEW" });
  }
  const previewDigest = contentDigest(canonicalJson({
    command: "changes.rollback:tune",
    change_id: options.changeId,
    current_digest: contentDigest(current.bytes),
    snapshot_digest: contentDigest(snapshot.bytes),
    base_existed: applied.base_existed,
  }));
  const preview = {
    change_id: options.changeId,
    target: "private-overlay",
    target_id: skillAlias,
    preview_digest: previewDigest,
    approval_classes: ["local-config-write"],
    mutated: false,
  };
  if (!options.applyDigest) return preview;
  if (options.applyDigest !== previewDigest) {
    throw Object.assign(new Error("Tune rollback approval digest is stale"), { code: "STALE_PREVIEW" });
  }
  return withLock(root, async () => {
    const latest = await readRegularFile(target);
    const latestSnapshot = await readRegularFile(snapshotPath);
    if (!latest.existed || contentDigest(latest.bytes) !== applied.preview_digest
      || !latestSnapshot.existed || contentDigest(latestSnapshot.bytes) !== applied.base_digest) {
      throw Object.assign(new Error("Tune overlay changed after rollback preview"), { code: "STALE_PREVIEW" });
    }
    if (applied.base_existed) await atomicWrite(target, latestSnapshot.bytes);
    else await rm(target, { force: true });
    const rollbackId = `rollback-${options.changeId}`;
    const rollbackRecord = {
      schema_version: 1,
      record_type: "tune-rollback",
      change_id: rollbackId,
      rolled_back_change_id: options.changeId,
      target_alias: applied.target_alias,
      restored_digest: applied.base_digest,
      applied_at: new Date().toISOString(),
    };
    try {
      await appendTuneJournal(root, rollbackRecord);
    } catch (error) {
      await atomicWrite(target, latest.bytes);
      throw error;
    }
    return { ...preview, change_id: rollbackId, rolled_back_change_id: options.changeId, mutated: true };
  });
}

export async function executeTuneCommand(arguments_: CliArguments, io: CommandIo): Promise<CommandExecution> {
  try {
    const input = await readInput(arguments_, io);
    const eventStateRoot = arguments_.stateRoot ?? DEFAULT_EVENT_STATE_ROOT;
    const state = await loadRetentionState(eventStateRoot);
    const candidate = approvedCandidate(state.candidates, state.approvals, input);
    const verified = verifyEvaluation(await loadEvalEvidenceArtifact(eventStateRoot, input.evaluation.evidence_id), input, candidate);
    const root = normalizeAbsolutePath(arguments_.config ?? join(homedir(), ".pragman"));
    const skillAlias = candidate.skill_id.replaceAll(":", "--");
    if (!/^[a-z0-9-]+$/.test(skillAlias)) throw Object.assign(new Error("Skill identity is unsafe for an overlay"), { code: "PRIVACY_DENIED" });
    const overlays = resolveContainedPath(root, join(root, "overlays"));
    const skillDirectory = resolveContainedPath(root, join(overlays, skillAlias));
    const rootExists = await assertRegularDirectoryIfPresent(root);
    const overlaysExist = rootExists && await assertRegularDirectoryIfPresent(overlays);
    if (overlaysExist) await assertRegularDirectoryIfPresent(skillDirectory);
    const target = resolveContainedPath(root, join(skillDirectory, "eval-candidates.jsonl"));
    const current = await readRegularFile(target);
    const entry = {
      schema_version: 1,
      candidate_id: candidate.candidate_id,
      candidate_digest: input.candidate_digest,
      skill_id: candidate.skill_id,
      skill_digest: candidate.skill_digest,
      scenario: input.scenario,
      evaluation_artifact_id: verified.artifact.evidence_id,
      evaluation_artifact_digest: verified.artifactDigest,
      approval_status: "approved",
    };
    try {
      if (current.bytes.split("\n").filter(Boolean).some((line) => (JSON.parse(line) as { candidate_id?: string }).candidate_id === candidate.candidate_id)) {
        throw Object.assign(new Error("Candidate already exists in this private overlay"), { code: "STALE_PREVIEW" });
      }
    } catch (error) {
      if ((error as { code?: string }).code === "STALE_PREVIEW") throw error;
      throw Object.assign(new Error("Private overlay is invalid"), { code: "PRIVACY_DENIED" });
    }
    const next = `${current.bytes}${canonicalJson(entry)}\n`;
    const previewDigest = contentDigest(next);
    const baseDigest = contentDigest(current.bytes);
    const changeId = `tune-${candidate.candidate_id}`;
    const preview = {
      mutated: false, target_alias: `private-overlay:${skillAlias}`, candidate_id: candidate.candidate_id,
      candidate_digest: input.candidate_digest, scenario: input.scenario,
      evaluation: { status: "COMPARABLE", passed: true, evidence_id: verified.artifact.evidence_id, artifact_digest: verified.artifactDigest },
      change_id: changeId, base_digest: baseDigest, preview_digest: previewDigest, approval_classes: ["private-overlay-write"],
    };
    if (!arguments_.applyDigest) {
      return { exitCode: EXIT_CODES.success, envelope: successEnvelope("tune", preview), human: `Tuning preview ${previewDigest}; a second approval is required.`, stderr: false };
    }
    if (arguments_.applyDigest !== previewDigest) throw Object.assign(new Error("Tune preview digest is stale"), { code: "STALE_PREVIEW" });
    await withLock(root, async () => {
      await ensureRegularDirectory(overlays);
      await ensureRegularDirectory(skillDirectory);
      const latest = await readRegularFile(target);
      if (latest.existed !== current.existed || contentDigest(latest.bytes) !== baseDigest) {
        throw Object.assign(new Error("Private overlay changed after preview"), { code: "STALE_PREVIEW" });
      }
      await preserveSnapshot(root, baseDigest, current.bytes);
      await atomicWrite(target, next);
      const appliedAt = new Date().toISOString();
      const record = {
        schema_version: 1,
        record_type: "tune-apply",
        change_id: changeId,
        candidate_id: candidate.candidate_id,
        candidate_digest: input.candidate_digest,
        target_alias: `private-overlay:${skillAlias}`,
        base_existed: current.existed,
        base_digest: baseDigest,
        preview_digest: previewDigest,
        evidence_id: verified.artifact.evidence_id,
        evidence_digest: verified.artifactDigest,
        comparison_skill_digest: verified.comparisonSkillDigest,
        approved_by: "local-user",
        applied_at: appliedAt,
        rollback: { available: true, snapshot_ref: baseDigest, rolled_back_at: null },
      };
      try {
        await appendTuneJournal(root, record);
      } catch (error) {
        if (current.existed) await atomicWrite(target, current.bytes);
        else await rm(target, { force: true });
        throw error;
      }
    });
    return { exitCode: EXIT_CODES.success, envelope: successEnvelope("tune", { ...preview, mutated: true }), human: `Applied approved candidate ${candidate.candidate_id} to a private overlay.`, stderr: false };
  } catch (error) {
    return failure(error);
  }
}

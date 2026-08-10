import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { normalizeAbsolutePath, resolveContainedPath } from "../../../config/src/index.ts";
import { appendDurable, createEvalCandidate, sha256Digest, type EvalCandidate } from "../../../events/src/index.ts";
import { redactText } from "../../../redaction/src/index.ts";
import { renderAnalysisJson, type AnalysisReport } from "../../../reports/src/index.ts";
import { scanSessions, SessionAdapterError, type SessionScanReport, type SessionSelection } from "../../../session-adapters/src/index.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import { DEFAULT_EVENT_STATE_ROOT, type CommandExecution, type CommandIo } from "./events.ts";

const MAX_PURGE_FILES = 10_000;
function stateRoot(arguments_: CliArguments): string { return normalizeAbsolutePath(arguments_.config ?? join(homedir(), ".pragman")); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

const CANDIDATE_PROPOSAL_FIELDS = [
  "candidate_id", "timestamp", "skill_id", "skill_digest", "corpus_id", "failure_codes", "redacted_artifact_alias",
] as const;

function proposedCandidate(value: unknown, report: SessionScanReport): EvalCandidate | null {
  if (value === undefined) return null;
  if (!object(value) || Object.keys(value).length !== CANDIDATE_PROPOSAL_FIELDS.length
    || Object.keys(value).some((key) => !(CANDIDATE_PROPOSAL_FIELDS as readonly string[]).includes(key))) {
    throw Object.assign(new Error("Candidate proposal must contain only content-free candidate fields"), { code: "INVALID_SELECTION" });
  }
  const analysisEvidenceDigest = sha256Digest({
    schema_version: 1,
    selection: report.selection,
    sessions_selected: report.sessions_selected,
    sessions_parsed: report.sessions_parsed,
    sessions_failed: report.sessions_failed,
    failure_ratio: report.failure_ratio,
    identity_collision: report.identity_collision,
    report_only: report.report_only,
    metrics: report.metrics,
    normalized_event_set_digest: sha256Digest(report.events),
    issue_codes: [...new Set([...report.quarantine, ...report.warnings].map((issue) => issue.code))].sort(),
  });
  const artifactDigest = sha256Digest({
    schema_version: 1,
    evidence_digest: analysisEvidenceDigest,
    skill_id: value.skill_id,
    corpus_id: value.corpus_id,
    failure_codes: value.failure_codes,
    artifact_alias: value.redacted_artifact_alias,
  });
  try {
    return createEvalCandidate({
      candidate_id: value.candidate_id as string,
      timestamp: value.timestamp as string,
      skill_id: value.skill_id as string,
      skill_digest: value.skill_digest as string,
      corpus_id: value.corpus_id as string,
      source_event_digests: [analysisEvidenceDigest],
      failure_codes: value.failure_codes as string[],
      redacted_artifact_alias: value.redacted_artifact_alias as string,
      redacted_artifact_digest: artifactDigest,
    });
  } catch {
    throw Object.assign(new Error("Candidate proposal is invalid or contains non-content-free fields"), { code: "INVALID_SELECTION" });
  }
}

async function candidateCreation(
  arguments_: CliArguments,
  report: SessionScanReport,
  questions: string[],
  proposal: unknown,
): Promise<Record<string, unknown> | null> {
  const candidate = proposedCandidate(proposal, report);
  if (!candidate) {
    if (arguments_.applyDigest) throw Object.assign(new Error("A candidate proposal is required before approval can be applied"), { code: "NEEDS_INPUT" });
    return null;
  }
  if (report.sessions_parsed < 1 || report.metrics.event_count < 1) {
    throw Object.assign(new Error("A non-empty successfully parsed session corpus is required to create an evaluation candidate"), { code: "NEEDS_INPUT" });
  }
  if (report.report_only) throw Object.assign(new Error("Report-only session evidence cannot create an evaluation candidate"), { code: "PRIVACY_DENIED" });
  if (questions.length > 0) throw Object.assign(new Error("Answer the focused context questions before creating an evaluation candidate"), { code: "NEEDS_INPUT" });
  const previewDigest = sha256Digest({ command: "sessions.analyze:candidate", candidate });
  const result: Record<string, unknown> = {
    candidate,
    candidate_digest: sha256Digest(candidate),
    preview_digest: previewDigest,
    approval_classes: ["local-eval-candidate-write"],
    mutated: false,
  };
  if (!arguments_.applyDigest) return result;
  if (arguments_.applyDigest !== previewDigest) throw Object.assign(new Error("Candidate creation approval digest is stale"), { code: "STALE_PREVIEW" });
  const appended = await appendDurable(arguments_.stateRoot ?? DEFAULT_EVENT_STATE_ROOT, "eval-candidates", candidate);
  if (appended.status === "quarantined" || appended.status === "rejected") {
    throw Object.assign(new Error("Evaluation candidate was rejected by the durable event store"), { code: "INVALID_SELECTION" });
  }
  return { ...result, mutated: appended.status === "appended", append_status: appended.status };
}

function failure(command: string, error: unknown): CommandExecution {
  const code = error instanceof SessionAdapterError ? error.code : typeof error === "object" && error !== null && "code" in error ? String(error.code) : "INTERNAL";
  const message = error instanceof Error ? error.message : "Session command failed";
  const exitCode = code === "NEEDS_INPUT" ? EXIT_CODES.needsInput : code === "INTERNAL" ? EXIT_CODES.internal
    : code === "SOURCE_UNREADABLE" ? EXIT_CODES.unavailable : code === "LOCK_TIMEOUT" || code === "TEMPORARY_FAILURE" ? EXIT_CODES.temporary
      : code === "STALE_PREVIEW" || code.includes("DENIED") ? EXIT_CODES.denied : EXIT_CODES.invalid;
  return { exitCode, envelope: errorEnvelope(command, code, message, null, exitCode === EXIT_CODES.temporary), human: message, stderr: true };
}

async function jsonInput(arguments_: CliArguments, io: CommandIo): Promise<unknown> {
  const raw = arguments_.file ? await readFile(arguments_.file, "utf8") : await io.readStdin();
  if (!raw.trim()) throw Object.assign(new Error("Explicit session selection JSON is required"), { code: "NEEDS_INPUT" });
  try { return JSON.parse(raw) as unknown; } catch { throw new SessionAdapterError("INVALID_SELECTION", "Session selection must be valid JSON"); }
}

function analyze(report: SessionScanReport, context: Record<string, unknown>): { report: AnalysisReport; questions: string[]; mutation_allowed: false } {
  const refs = [`metric:events-${report.metrics.event_count}`, `metric:sessions-${report.sessions_parsed}`];
  const intended = typeof context.intended_outcome === "string" && context.intended_outcome.trim() ? redactText(context.intended_outcome.trim()) : null;
  const external = typeof context.external_constraints === "string" && context.external_constraints.trim() ? redactText(context.external_constraints.trim()) : null;
  const intentional = typeof context.intentional_waits === "string" && context.intentional_waits.trim() ? redactText(context.intentional_waits.trim()) : null;
  const questions: string[] = [];
  if (!intended) questions.push("What outcome were these sessions meant to achieve, and how would you recognize success?");
  if (!external) questions.push("Which external constraints or dependencies are absent from the session records?");
  if (!intentional && (report.metrics.interruption_count > 0 || report.metrics.compaction_count > 0)) questions.push("Which waits, interruptions, or compactions were intentional rather than avoidable?");
  const complete = report.sessions_parsed > 0 && !report.report_only;
  const analysis: AnalysisReport = {
    schema_version: 1,
    title: "Agentic workflow analysis",
    subject: report.selection.project_aliases.join(", "),
    summary: `${report.sessions_parsed} sessions produced ${report.metrics.event_count} observable events. ${complete ? "Evidence passed the integrity threshold." : "Evidence is incomplete or report-only; automatic tuning is prohibited."}`,
    evidence: [
      { claim: `${report.metrics.tool_error_count} tool errors, ${report.metrics.compaction_count} compactions, and ${report.metrics.interruption_count} interruptions were observed.`, evidence_refs: refs, confidence: "high" },
      { claim: intended ? "The intended outcome was supplied outside the logs." : "The intended outcome is not established by observable records alone.", evidence_refs: refs, confidence: intended ? "medium" : "low" },
    ],
    dimensions: {
      "intent-versus-outcome": intended ? `User-supplied intent: ${intended}. Observable completion still requires artifact evidence.` : "Intent is missing; outcome quality cannot be inferred from activity alone.",
      "scope-and-routing-quality": "The selected projects and source adapters bound this analysis; route quality requires the original task contract.",
      "assumptions-and-decisions": "Only observable lifecycle decisions are counted; transcript instructions are treated as untrusted evidence.",
      "context-completeness": `${questions.length} focused context questions remain; ${report.sessions_failed} selected sessions failed parsing.`,
      "provider-and-tool-fit": `${report.metrics.tool_count} tool events and ${report.metrics.tool_error_count} tool errors were observed; fit requires intended-outcome context.`,
      "time-versus-value": "Elapsed activity is not treated as waste without outcome value and intentional-wait context.",
      "rework-compactions-retries-waits": `${report.metrics.compaction_count} compactions and ${report.metrics.interruption_count} interruptions were observed; retries are not invented from message count.`,
      "verification-and-quality": complete ? "Parsing integrity is sufficient for recommendations, not for completion claims." : "Integrity threshold prevents configuration changes.",
      "human-agent-collaboration": "Missing intent and external context are returned as focused questions rather than inferred from transcripts.",
      "external-blockers": external ? `User-supplied constraints: ${external}.` : "External blockers are unknown until the user supplies context.",
      "reusable-learning": "Retain only evidence-backed, user-approved learning; pending recommendations do not update skills or routing.",
    },
    actions: {
      Keep: [{ action: "Keep bounded, source-selected session analysis.", rationale: "It preserves privacy and makes evidence coverage explicit.", evidence_refs: refs, confidence: "high" }],
      Change: questions.length ? [{ action: "Answer the focused context questions before tuning.", rationale: "Logs do not reliably contain intent or external constraints.", evidence_refs: refs, confidence: "high" }] : [],
      Stop: report.report_only ? [{ action: "Stop automatic configuration changes from this corpus.", rationale: "Integrity, best-effort, or failure thresholds make this report-only evidence.", evidence_refs: refs, confidence: "high" }] : [],
      Automate: report.metrics.tool_error_count > 0 ? [{ action: "Test a deterministic preflight for the repeated tool failure class.", rationale: "Tool errors are observable, but their common cause still needs validation.", evidence_refs: refs, confidence: "medium" }] : [],
      Learn: complete && intended ? [{ action: "Propose a sanitized private overlay learning for review.", rationale: "The corpus and external intent are sufficient to draft—not apply—a learning.", evidence_refs: refs, confidence: "medium" }] : [],
      "Test next": [{ action: "Compare the proposed workflow on paired behavioral scenarios before approval.", rationale: "A plausible recommendation is not evidence of improvement.", evidence_refs: refs, confidence: "high" }],
    },
  };
  return { report: JSON.parse(renderAnalysisJson(analysis)) as AnalysisReport, questions, mutation_allowed: false };
}

async function purgeFiles(arguments_: CliArguments, kind: "sessions" | "history"): Promise<CommandExecution> {
  const command = kind === "sessions" ? "sessions.purge" : "history.purge";
  const root = stateRoot(arguments_);
  const directory = kind === "sessions" ? join(root, "state", "sessions") : join(root, "history", "snapshots");
  resolveContainedPath(root, directory);
  const through = arguments_.through ? Date.parse(arguments_.through) : Date.now();
  if (!Number.isFinite(through)) throw new SessionAdapterError("INVALID_SELECTION", "--through must be an RFC 3339 timestamp");
  const selected: Array<{ path: string; alias: string; size: number; modified: string }> = [];
  let entries: Dirent[];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
    else throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (selected.length >= MAX_PURGE_FILES) throw new SessionAdapterError("FILE_LIMIT", "Purge selection exceeds the file limit");
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.mtimeMs <= through) selected.push({ path, alias: `${kind}-artifact-${selected.length + 1}`, size: info.size, modified: info.mtime.toISOString() });
  }
  const previewDigest = digest(selected.map(({ alias, size, modified }) => ({ alias, size, modified })));
  const preview = { kind, file_count: selected.length, byte_count: selected.reduce((sum, entry) => sum + entry.size, 0), through: new Date(through).toISOString(), preview_digest: previewDigest, mutated: false };
  if (!arguments_.applyDigest) return { exitCode: EXIT_CODES.success, envelope: successEnvelope(command, preview), human: `Preview purge of ${selected.length} ${kind} files; apply digest ${previewDigest}.`, stderr: false };
  if (arguments_.applyDigest !== previewDigest) throw Object.assign(new Error("Purge selection changed after preview"), { code: "STALE_PREVIEW" });
  for (const entry of selected) {
    const relation = relative(directory, entry.path);
    if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new SessionAdapterError("PRIVACY_DENIED", "Purge target escaped its selected root");
    await rm(entry.path);
  }
  return { exitCode: EXIT_CODES.success, envelope: successEnvelope(command, { ...preview, mutated: true }), human: `Purged ${selected.length} ${kind} files; source transcripts were never copied or deleted.`, stderr: false };
}

export async function executeSessionsCommand(arguments_: CliArguments, io: CommandIo): Promise<CommandExecution> {
  const command = arguments_.command;
  try {
    if (command === "sessions.purge") return await purgeFiles(arguments_, "sessions");
    const value = await jsonInput(arguments_, io);
    const wrapper = command === "sessions.analyze" && object(value) && object(value.selection) ? value : { selection: value, context: {} };
    const report = await scanSessions(
      wrapper.selection as unknown as SessionSelection,
      command === "sessions.scan" && arguments_.applyDigest ? { releaseExcerptDigest: arguments_.applyDigest } : {},
    );
    if (command === "sessions.scan") return { exitCode: EXIT_CODES.success, envelope: successEnvelope(command, report), human: `${report.sessions_parsed}/${report.sessions_selected} sessions parsed${report.report_only ? " (report only)" : ""}.`, stderr: false };
    const result = analyze(report, object(wrapper.context) ? wrapper.context : {});
    const candidate = await candidateCreation(arguments_, report, result.questions, object(wrapper) ? wrapper.candidate : undefined);
    const data = candidate ? { ...result, candidate_creation: candidate } : result;
    return { exitCode: EXIT_CODES.success, envelope: successEnvelope(command, data), human: `${report.sessions_parsed} sessions analyzed; ${result.questions.length} context questions remain.`, stderr: false };
  } catch (error) {
    return failure(command, error);
  }
}

export async function executeHistoryPurgeCommand(arguments_: CliArguments): Promise<CommandExecution> {
  try { return await purgeFiles(arguments_, "history"); } catch (error) { return failure("history.purge", error); }
}

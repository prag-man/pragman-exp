import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { normalizeAbsolutePath, resolveContainedPath } from "../../../config/src/index.ts";
import { renderAnalysisJson, type AnalysisReport } from "../../../reports/src/index.ts";
import { scanSessions, SessionAdapterError, type SessionScanReport, type SessionSelection } from "../../../session-adapters/src/index.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution, CommandIo } from "./events.ts";

const MAX_PURGE_FILES = 10_000;
function stateRoot(arguments_: CliArguments): string { return normalizeAbsolutePath(arguments_.config ?? join(homedir(), ".pragman")); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

function failure(command: string, error: unknown): CommandExecution {
  const code = error instanceof SessionAdapterError ? error.code : typeof error === "object" && error !== null && "code" in error ? String(error.code) : "INTERNAL";
  const message = error instanceof Error ? error.message : "Session command failed";
  const exitCode = code === "NEEDS_INPUT" ? EXIT_CODES.needsInput : code === "INTERNAL" ? EXIT_CODES.internal
    : code === "SOURCE_UNREADABLE" ? EXIT_CODES.unavailable : code === "STALE_PREVIEW" || code.includes("DENIED") ? EXIT_CODES.denied : EXIT_CODES.invalid;
  return { exitCode, envelope: errorEnvelope(command, code, message), human: message, stderr: true };
}

async function jsonInput(arguments_: CliArguments, io: CommandIo): Promise<unknown> {
  const raw = arguments_.file ? await readFile(arguments_.file, "utf8") : await io.readStdin();
  if (!raw.trim()) throw Object.assign(new Error("Explicit session selection JSON is required"), { code: "NEEDS_INPUT" });
  try { return JSON.parse(raw) as unknown; } catch { throw new SessionAdapterError("INVALID_SELECTION", "Session selection must be valid JSON"); }
}

function analyze(report: SessionScanReport, context: Record<string, unknown>): { report: AnalysisReport; questions: string[]; mutation_allowed: false } {
  const refs = [`metric:events-${report.metrics.event_count}`, `metric:sessions-${report.sessions_parsed}`];
  const intended = typeof context.intended_outcome === "string" && context.intended_outcome.trim() ? context.intended_outcome.trim() : null;
  const external = typeof context.external_constraints === "string" && context.external_constraints.trim() ? context.external_constraints.trim() : null;
  const intentional = typeof context.intentional_waits === "string" && context.intentional_waits.trim() ? context.intentional_waits.trim() : null;
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
    return { exitCode: EXIT_CODES.success, envelope: successEnvelope(command, result), human: `${report.sessions_parsed} sessions analyzed; ${result.questions.length} context questions remain.`, stderr: false };
  } catch (error) {
    return failure(command, error);
  }
}

export async function executeHistoryPurgeCommand(arguments_: CliArguments): Promise<CommandExecution> {
  try { return await purgeFiles(arguments_, "history"); } catch (error) { return failure("history.purge", error); }
}

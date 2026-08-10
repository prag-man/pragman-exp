import { copyFile, lstat, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateWeeklyRollups,
  applyExportPlan,
  applyRetentionPlan,
  buildDailyRollups,
  canonicalJson,
  calculateRoutingMetrics,
  createEvalCandidateDecision,
  createEventValidators,
  createExportPlan,
  createLifecycleIndex,
  createPurgePlan,
  loadEventSettings,
  retentionStateDigest,
  runAutomaticRetentionUnderLock,
  sealRollup,
  verifyRollup,
  rebuildRollups,
  resolveStateRoot,
  sha256Digest,
  type EvalCandidate,
  type EvalCandidateApproval,
  type ExplicitPurgePlan,
  type ExportPlan,
  type PurgeClass,
  type RetentionPolicy,
  type RetentionState,
  type SkillEvent,
  type SkillMetric,
  type SkillRollup,
  type SkillScore,
} from "../../../events/src/index.ts";
import { resolveContainedDirectory, resolveContainedFile } from "../../../events/src/paths.ts";
import {
  EVENT_STATE_REPLACEMENT_TARGETS,
  mutateDurableRecord,
  recoverEventStateReplacement,
  withEventStateTransaction,
  type EventStateTransaction,
} from "../../../events/src/store.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope, type ErrorEnvelope, type SuccessEnvelope } from "../envelope.ts";

export type CommandEnvelope = SuccessEnvelope<unknown> | ErrorEnvelope;
export interface CommandExecution { exitCode: number; envelope: CommandEnvelope; human: string; stderr?: boolean }
export interface CommandIo { readStdin(): Promise<string> }

export const DEFAULT_EVENT_STATE_ROOT = join(homedir(), ".pragman", "state", "events");

const PRIVACY_KEYS = new Set(["prompt", "output", "response", "transcript", "notes", "corpus_patch", "tool_arguments", "raw_content"]);
const SECRET_PATTERN = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/;

function execution(exitCode: number, envelope: CommandEnvelope, human: string, stderr = false): CommandExecution {
  return { exitCode, envelope, human, stderr };
}

function fail(command: string, exitCode: number, code: string, message: string, details: unknown = null, retryable = false): CommandExecution {
  return execution(exitCode, errorEnvelope(command, code, message, details, retryable), message, true);
}

function privacyUnsafe(value: unknown): boolean {
  if (typeof value === "string") return SECRET_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(privacyUnsafe);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, child]) => PRIVACY_KEYS.has(key) || privacyUnsafe(child));
  }
  return false;
}

async function readJsonInput(arguments_: CliArguments, io: CommandIo): Promise<{ ok: true; value: unknown } | { ok: false; result: CommandExecution }> {
  let text: string;
  try {
    text = arguments_.file ? await readFile(arguments_.file, "utf8") : await io.readStdin();
  } catch (error) {
    return { ok: false, result: fail(arguments_.command, EXIT_CODES.invalid, "INVALID_INPUT", `Unable to read selected JSON input`, { cause: error instanceof Error ? error.message : String(error) }) };
  }
  if (text.trim().length === 0) return { ok: false, result: fail(arguments_.command, EXIT_CODES.needsInput, "NEEDS_INPUT", "JSON input is required on stdin or through --file") };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, result: fail(arguments_.command, EXIT_CODES.invalid, "INVALID_INPUT", "Input must be valid JSON") };
  }
}

async function partitionDates(root: string, directory: "skill-events" | "scores" | "eval-candidates" | "candidate-approvals"): Promise<string[]> {
  try {
    const contained = await resolveContainedDirectory(root, directory);
    const entries = await readdir(contained, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)).map((entry) => entry.name.slice(0, 10)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readRecordType<T>(transaction: EventStateTransaction, directory: "skill-events" | "scores" | "eval-candidates" | "candidate-approvals"): Promise<T[]> {
  const root = transaction.root;
  const dates = await partitionDates(root, directory);
  const result: T[] = [];
  for (const date of dates) {
    const partition = await transaction.readPartition<T>(directory, date);
    result.push(...partition.records);
  }
  return result;
}

async function readRollups(root: string, period: "daily" | "weekly"): Promise<SkillRollup[]> {
  const directory = await resolveContainedDirectory(root, "rollups", period);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const result: SkillRollup[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = await resolveContainedFile(root, "rollups", [period], entry.name);
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      const records = Array.isArray(value) ? value : [value];
      for (const record of records) {
        const validation = createEventValidators().rollup(record);
        if (!validation.ok) throw Object.assign(new Error("SCHEMA_INVALID"), { code: "SCHEMA_INVALID" });
        result.push(validation.value);
      }
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function loadRetentionStateInTransaction(transaction: EventStateTransaction): Promise<RetentionState> {
  const root = transaction.root;
  const events = await readRecordType<SkillEvent>(transaction, "skill-events");
  const scores = await readRecordType<SkillScore>(transaction, "scores");
  const candidates = await readRecordType<EvalCandidate>(transaction, "eval-candidates");
  const approvals = await readRecordType<EvalCandidateApproval>(transaction, "candidate-approvals");
  const quarantine = [];
  try {
    const quarantineDirectory = await resolveContainedDirectory(root, "quarantine");
    const entries = await readdir(quarantineDirectory, { withFileTypes: true });
    for (const entry of entries) if (entry.isFile()) {
      const metadata = await stat(join(quarantineDirectory, entry.name));
      quarantine.push({ quarantine_id: entry.name, timestamp: metadata.mtime.toISOString() });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    events,
    scores,
    candidates,
    approvals,
    daily_rollups: await readRollups(root, "daily"),
    weekly_rollups: await readRollups(root, "weekly"),
    quarantine,
  };
}

export async function loadRetentionState(configuredRoot: string): Promise<RetentionState> {
  return withEventStateTransaction(configuredRoot, loadRetentionStateInTransaction, { lockTimeoutMs: 250 });
}

async function readMetrics(): Promise<SkillMetric[]> {
  let cursor = dirname(fileURLToPath(import.meta.url));
  let directory = join(process.cwd(), "evals", "metrics");
  while (true) {
    const candidate = join(cursor, "evals", "metrics");
    try { if ((await stat(candidate)).isDirectory()) { directory = candidate; break; } } catch { /* continue upward */ }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const result: SkillMetric[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && entry.name.endsWith(".json")) result.push(JSON.parse(await readFile(join(directory, entry.name), "utf8")) as SkillMetric);
    }
    return result;
  } catch {
    return [];
  }
}

function indexState(state: RetentionState) {
  const index = createLifecycleIndex();
  for (const event of [...state.events].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) index.addEvent(event);
  for (const score of [...state.scores].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) index.addScore(score);
  for (const candidate of [...state.candidates].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) index.addCandidate(candidate);
  for (const approval of [...state.approvals].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) index.addApproval(approval);
  return index;
}

async function writePlan(root: string, plan: ExportPlan | ExplicitPurgePlan): Promise<void> {
  const path = await resolveContainedFile(root, "plans", [], `${plan.plan_digest}.json`);
  const handle = await open(path, "wx", 0o600);
  try { await handle.write(`${canonicalJson(plan)}\n`); await handle.sync(); } finally { await handle.close(); }
}

async function readPlan<T>(root: string, digest: string): Promise<T | null> {
  if (!/^[a-f0-9]{64}$/.test(digest)) return null;
  const path = await resolveContainedFile(root, "plans", [], `${digest}.json`);
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeSynced(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.write(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeRecordType<T extends { timestamp: string }>(target: string, values: readonly T[]): Promise<void> {
  await mkdir(target, { recursive: true });
  const groups = new Map<string, T[]>();
  for (const value of values) { const date = value.timestamp.slice(0, 10); const group = groups.get(date) ?? []; group.push(value); groups.set(date, group); }
  for (const [date, records] of groups) await writeSynced(join(target, `${date}.jsonl`), `${records.map(canonicalJson).join("\n")}\n`);
  await syncDirectory(target);
}

async function writeRollupType(target: string, values: readonly SkillRollup[]): Promise<void> {
  await mkdir(target, { recursive: true });
  const groups = new Map<string, SkillRollup[]>();
  for (const rollup of values) {
    const key = rollup.period_start.slice(0, 10);
    const group = groups.get(key) ?? [];
    group.push(rollup);
    groups.set(key, group);
  }
  for (const [key, records] of groups) await writeSynced(join(target, `${key}.json`), `${canonicalJson(records)}\n`);
  await syncDirectory(target);
}

interface ReplacementMarker {
  schema_version: 1;
  transaction_id: string;
  targets: typeof EVENT_STATE_REPLACEMENT_TARGETS;
}

async function writeReplacementMarker(root: string, marker: ReplacementMarker): Promise<void> {
  const markerPath = await resolveContainedFile(root, "transactions", [], "active-replacement.json");
  const temporaryName = `active-replacement-${randomUUID()}.tmp`;
  const temporaryPath = await resolveContainedFile(root, "transactions", [], temporaryName);
  await writeSynced(temporaryPath, `${canonicalJson(marker)}\n`);
  await rename(temporaryPath, markerPath);
  await syncDirectory(await resolveContainedDirectory(root, "transactions"));
}

async function persistStateReplacement(root: string, state: RetentionState): Promise<void> {
  const transactionId = randomUUID();
  const transactionRoot = await resolveContainedDirectory(root, "transactions", transactionId);
  const nextRoot = await resolveContainedDirectory(transactionRoot, "transactions", "next");
  await resolveContainedDirectory(transactionRoot, "transactions", "backup");
  await writeRecordType(join(nextRoot, "skill-events"), state.events);
  await writeRecordType(join(nextRoot, "scores"), state.scores);
  await writeRecordType(join(nextRoot, "eval-candidates"), state.candidates);
  await writeRecordType(join(nextRoot, "candidate-approvals"), state.approvals);
  const stagedQuarantine = join(nextRoot, "quarantine");
  await mkdir(stagedQuarantine, { recursive: true });
  const liveQuarantine = await resolveContainedDirectory(root, "quarantine");
  for (const record of state.quarantine) {
    if (!/^[A-Za-z0-9._-]+$/.test(record.quarantine_id)) throw Object.assign(new Error("PATH_ESCAPE"), { code: "PATH_ESCAPE" });
    const source = join(liveQuarantine, record.quarantine_id);
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw Object.assign(new Error("PATH_ESCAPE"), { code: "PATH_ESCAPE" });
    const destination = join(stagedQuarantine, record.quarantine_id);
    await copyFile(source, destination);
    const copied = await open(destination, "r");
    try { await copied.sync(); } finally { await copied.close(); }
  }
  await syncDirectory(stagedQuarantine);
  await writeRollupType(join(nextRoot, "rollups", "daily"), state.daily_rollups);
  await writeRollupType(join(nextRoot, "rollups", "weekly"), state.weekly_rollups);
  await syncDirectory(join(nextRoot, "rollups"));
  await syncDirectory(nextRoot);
  await writeReplacementMarker(root, { schema_version: 1, transaction_id: transactionId, targets: EVENT_STATE_REPLACEMENT_TARGETS });
  const injectedCrashAfter = Number.parseInt(process.env.PRAGMAN_EVENTS_TEST_CRASH_AFTER_SWAP ?? "", 10);
  await recoverEventStateReplacement(root, Number.isSafeInteger(injectedCrashAfter) && injectedCrashAfter > 0
    ? { crashAfterSwaps: injectedCrashAfter }
    : {});
}

async function persistRollups(root: string, daily: readonly SkillRollup[], weekly: readonly SkillRollup[], current: RetentionState): Promise<void> {
  await persistStateReplacement(root, { ...current, daily_rollups: [...daily], weekly_rollups: [...weekly] });
}

async function runSummaryRetention(
  root: string,
  state: RetentionState,
  policy: RetentionPolicy,
): Promise<{ state: RetentionState; summary: Record<string, unknown> }> {
  const metrics = await readMetrics();
  const registry = new Map(metrics.map((metric) => [sha256Digest(metric), metric]));
  let dailyRollups = [...state.daily_rollups];
  let weeklyRollups = [...state.weekly_rollups];
  const result = await runAutomaticRetentionUnderLock(state, {
    isMetricDefinitionAvailable(metricDefinitionDigest, metricId) {
      return registry.get(metricDefinitionDigest)?.metric_id === metricId;
    },
    async sealAndVerifyDaily(date) {
      if (process.env.PRAGMAN_EVENTS_TEST_RETENTION_DEBT_DAY === date) return false;
      const rebuilt = buildDailyRollups(state.events, state.scores, registry, date);
      if (rebuilt.length === 0) return false;
      const sealed = rebuilt.map(sealRollup);
      if (!sealed.every((rollup) => verifyRollup(rollup, state.events, state.scores, registry).valid)) return false;
      dailyRollups = [
        ...dailyRollups.filter((rollup) => rollup.period_start.slice(0, 10) !== date),
        ...sealed,
      ];
      return true;
    },
    async recomputeWeekly(weekStart) {
      const rebuilt = aggregateWeeklyRollups(dailyRollups, weekStart);
      if (!rebuilt.every((rollup) => createEventValidators().rollup(rollup).ok)) return false;
      weeklyRollups = [
        ...weeklyRollups.filter((rollup) => rollup.period_start.slice(0, 10) !== weekStart),
        ...rebuilt,
      ];
      return true;
    },
  }, { policy });

  if (!result.applied) {
    const unavailableMetricDigests = result.debt.unavailable_metric_definition_digests.slice(0, 100);
    const sealDays = result.debt.seal_and_verify_days.slice(0, Math.max(0, 100 - unavailableMetricDigests.length));
    const weekStarts = result.debt.recompute_week_starts.slice(
      0,
      Math.max(0, 100 - unavailableMetricDigests.length - sealDays.length),
    );
    const debt = {
      ...(unavailableMetricDigests.length > 0
        ? { unavailable_metric_definition_digests: unavailableMetricDigests }
        : {}),
      seal_and_verify_days: sealDays,
      recompute_week_starts: weekStarts,
    };
    return {
      state,
      summary: {
        applied: false,
        reason: result.reason,
        debt,
        truncated: unavailableMetricDigests.length + sealDays.length + weekStarts.length
          < result.debt.unavailable_metric_definition_digests.length
            + result.debt.seal_and_verify_days.length
            + result.debt.recompute_week_starts.length,
      },
    };
  }

  const removedDaily = new Set(result.removed.daily_rollup_ids);
  const removedWeekly = new Set(result.removed.weekly_rollup_ids);
  const nextState: RetentionState = {
    ...result.state,
    daily_rollups: dailyRollups.filter((rollup) => !removedDaily.has(rollup.rollup_id)),
    weekly_rollups: weeklyRollups.filter((rollup) => !removedWeekly.has(rollup.rollup_id)),
  };
  const removedCounts = Object.fromEntries(Object.entries(result.removed).map(([recordClass, ids]) => [recordClass, ids.length]));
  if (Object.values(removedCounts).some((count) => count > 0)) await persistStateReplacement(root, nextState);
  return { state: nextState, summary: { applied: true, reason: null, removed_counts: removedCounts } };
}

export async function executeEventsCommand(arguments_: CliArguments, io: CommandIo): Promise<CommandExecution> {
  const command = arguments_.command;
  const configuredRoot = arguments_.stateRoot ?? DEFAULT_EVENT_STATE_ROOT;
  let root: string;
  try { root = await resolveStateRoot(configuredRoot); }
  catch (error) { return fail(command, EXIT_CODES.denied, "PRIVACY_DENIED", "Unsafe event state root", { cause: error instanceof Error ? error.message : String(error) }); }
  const settings = await loadEventSettings(arguments_.config);
  if (!settings.ok) return fail(command, EXIT_CODES.invalid, settings.code, "Personal configuration is invalid; local measurement is fail-closed");

  try {
    if (command === "events.record" || command === "events.score") {
      if (!settings.local_events && !arguments_.overrideLocalEvents) {
        const data = { recorded: false, reason: "DISABLED", override_available: true };
        return execution(EXIT_CODES.success, successEnvelope(command, data), "Local event measurement is disabled; nothing was written.");
      }
      const input = await readJsonInput(arguments_, io);
      if (!input.ok) return input.result;
      if (privacyUnsafe(input.value)) return fail(command, EXIT_CODES.denied, "PRIVACY_DENIED", "Content or secret-bearing fields are forbidden in event storage");
      if (command === "events.record") {
        const validation = createEventValidators().event(input.value);
        if (!validation.ok) return fail(command, EXIT_CODES.invalid, validation.code, "Event record failed validation");
        const appended = await mutateDurableRecord(root, "skill-events", validation.value, { lockTimeoutMs: 250 });
        if (appended.status === "rejected" || appended.status === "quarantined") {
          return fail(command, EXIT_CODES.invalid, appended.reason, "Event lifecycle rejected the record");
        }
        const data = { recorded: appended.status === "appended" || appended.status === "duplicate", status: appended.status, digest: appended.digest };
        return execution(EXIT_CODES.success, successEnvelope(command, data), `Event ${appended.status}.`);
      }
      const metrics = await readMetrics();
      const score = input.value as Partial<SkillScore>;
      const metric = metrics.find((candidate) => sha256Digest(candidate) === score.metric_definition_digest);
      if (!metric) return fail(command, EXIT_CODES.invalid, "UNKNOWN_METRIC_DEFINITION", "Score references an unknown metric definition");
      const validation = createEventValidators(metrics).score(input.value, metric);
      if (!validation.ok) return fail(command, EXIT_CODES.invalid, validation.code, "Score record failed validation");
      const appended = await mutateDurableRecord(root, "scores", validation.value, { lockTimeoutMs: 250 });
      if (appended.status === "rejected" || appended.status === "quarantined") {
        return fail(command, EXIT_CODES.invalid, appended.reason, "Score lifecycle rejected the record");
      }
      return execution(EXIT_CODES.success, successEnvelope(command, { recorded: true, status: appended.status, digest: appended.digest }), `Score ${appended.status}.`);
    }

    return await withEventStateTransaction(root, async (transaction) => {
      let state = await loadRetentionStateInTransaction(transaction);
      if (command === "events.list") {
        const records = [...state.events]
          .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
          .slice(0, 100)
          .map((event) => ({
            timestamp: event.timestamp,
            event_type: event.event_type,
            skill_type: event.skill_type,
            host: event.host,
            invocation_mode: event.invocation_mode,
            status: event.status,
            observation_source: event.observation_source,
          }));
        const data = {
          records,
          total_events: state.events.length,
          total_scores: state.scores.length,
          truncated: state.events.length > records.length,
        };
        return execution(EXIT_CODES.success, successEnvelope(command, data), `${state.events.length} events; ${state.scores.length} scores.`);
      }
      if (command === "events.summary") {
        const retention = await runSummaryRetention(root, state, settings.retention_policy);
        state = retention.state;
        const lifecycle = indexState(state);
        const coverage = Object.fromEntries(["router", "host-adapter", "cli", "eval-runner", "user-report"].map((source) => [source, state.events.filter((event) => event.observation_source === source).length]));
        const invokedIds = new Set(state.events.filter((event) => event.event_type === "invoked").map((event) => event.invocation_id));
        const terminalIds = new Set(state.events.filter((event) => event.event_type === "completed" || event.event_type === "cancelled").map((event) => event.invocation_id));
        const completionNumerator = [...invokedIds].filter((id) => terminalIds.has(id)).length;
        const data = {
          observed_invocations: invokedIds.size,
          incomplete_invocations: lifecycle.incompleteInvocationIds().length,
          completion: { numerator: completionNumerator, denominator: invokedIds.size, rate: invokedIds.size === 0 ? null : completionNumerator / invokedIds.size },
          routing: calculateRoutingMetrics(state.events),
          observation_source_counts: coverage,
          cohort_dimensions: [...new Set(state.daily_rollups.map((rollup) => canonicalJson(rollup.dimensions)))].sort().map((value) => JSON.parse(value) as unknown),
          daily_rollups: state.daily_rollups.length,
          weekly_rollups: state.weekly_rollups.length,
          retention: retention.summary,
        };
        return execution(EXIT_CODES.success, successEnvelope(command, data), `${data.observed_invocations} observed invocations; ${data.incomplete_invocations} incomplete.`);
      }
      if (command === "events.candidates.list") {
        const decisions = new Map(state.approvals.map((approval) => [approval.candidate_id, approval]));
        const data = state.candidates.map((candidate) => ({ candidate, candidate_digest: sha256Digest(candidate), decision: decisions.get(candidate.candidate_id) ?? null }));
        return execution(EXIT_CODES.success, successEnvelope(command, { candidates: data }), `${data.length} evaluation candidates.`);
      }
      if (command === "events.candidates.decide") {
        const input = await readJsonInput(arguments_, io);
        if (!input.ok) return input.result;
        if (privacyUnsafe(input.value) || !input.value || typeof input.value !== "object") return fail(command, EXIT_CODES.denied, "PRIVACY_DENIED", "Candidate decisions must remain content-free");
        const proposed = input.value as Record<string, unknown>;
        const candidate = state.candidates.find((entry) => entry.candidate_id === proposed.candidate_id);
        if (!candidate) return fail(command, EXIT_CODES.invalid, "UNKNOWN_CANDIDATE", "Candidate does not exist");
        const decision = createEvalCandidateDecision({ approval_id: String(proposed.approval_id ?? ""), timestamp: String(proposed.timestamp ?? ""), candidate, decision: proposed.decision as "approved" | "rejected", reviewed_redacted_artifact_digest: String(proposed.reviewed_redacted_artifact_digest ?? "") });
        const appended = await transaction.mutate("candidate-approvals", decision);
        if (appended.status === "rejected" || appended.status === "quarantined") return fail(command, EXIT_CODES.invalid, appended.reason, "Candidate decision was rejected");
        return execution(EXIT_CODES.success, successEnvelope(command, { decided: true, status: appended.status, decision }), `Candidate ${decision.decision}.`);
      }
      if (command === "events.export") {
        if (arguments_.applyDigest) {
          const plan = await readPlan<ExportPlan>(root, arguments_.applyDigest);
          if (!plan || plan.plan_digest !== arguments_.applyDigest) return fail(command, EXIT_CODES.denied, "STALE_PREVIEW", "Export preview digest is missing or invalid");
          const applied = applyExportPlan(plan, state);
          if (!applied.ok) return fail(command, applied.reason === "PLAN_EXPIRED" ? EXIT_CODES.needsInput : EXIT_CODES.denied, applied.reason, "Export preview can no longer be applied");
          return execution(EXIT_CODES.success, successEnvelope(command, applied.value), "Export produced.");
        }
        const plan = arguments_.raw
          ? createExportPlan(state, { mode: "raw", confirm_content_free_raw: arguments_.confirmContentFreeRaw }, new Date())
          : createExportPlan(state, {}, new Date());
        if (plan.status === "NEEDS_APPROVAL") return fail(command, EXIT_CODES.needsInput, "NEEDS_APPROVAL", plan.message, plan.preview);
        await writePlan(root, plan);
        return execution(EXIT_CODES.success, successEnvelope(command, { preview_digest: plan.plan_digest, plan }), `Export preview ${plan.plan_digest}.`);
      }
      if (command === "events.purge") {
        if (arguments_.applyDigest) {
          const plan = await readPlan<ExplicitPurgePlan>(root, arguments_.applyDigest);
          if (!plan || plan.plan_digest !== arguments_.applyDigest || plan.kind !== "explicit-purge") return fail(command, EXIT_CODES.denied, "STALE_PREVIEW", "Purge preview digest is missing or invalid");
          if (retentionStateDigest(state) !== plan.current_state_digest) return fail(command, EXIT_CODES.denied, "STALE_STATE", "Purge preview can no longer be applied");
          const applied = await applyRetentionPlan(plan, state, {
            now: () => new Date(),
            withMutationLock: (operation) => operation(),
            sealAndVerifyDaily: async () => true,
            recomputeWeekly: async () => true,
          });
          if (!applied.applied) return fail(command, applied.reason === "PLAN_EXPIRED" ? EXIT_CODES.needsInput : EXIT_CODES.denied, applied.reason, "Purge preview can no longer be applied");
          await persistStateReplacement(root, applied.state);
          const verified = await loadRetentionStateInTransaction(transaction);
          const remaining = new Set([
            ...verified.events.map((value) => value.event_id), ...verified.scores.map((value) => value.score_id),
            ...verified.candidates.map((value) => value.candidate_id), ...verified.approvals.map((value) => value.approval_id),
            ...verified.daily_rollups.map((value) => value.rollup_id), ...verified.weekly_rollups.map((value) => value.rollup_id),
            ...verified.quarantine.map((value) => value.quarantine_id),
          ]);
          if (Object.values(applied.removed).flat().some((id) => remaining.has(id))) throw Object.assign(new Error("PURGE_VERIFY_FAILED"), { code: "PURGE_VERIFY_FAILED" });
          return execution(EXIT_CODES.success, successEnvelope(command, { purged: applied.removed, history_rebuildable: false }), "Selected history purged; the removed period is no longer rebuildable.");
        }
        if (arguments_.classes.length === 0 || !arguments_.from || !arguments_.through) return fail(command, EXIT_CODES.needsInput, "NEEDS_INPUT", "Purge requires explicit --class, --from, and --through selections");
        const allowed = new Set(["raw", "candidates", "daily-rollups", "weekly-rollups", "quarantine", "all"]);
        if (arguments_.classes.some((value) => !allowed.has(value))) return fail(command, EXIT_CODES.invalid, "INVALID_INPUT", "Unknown purge record class", { classes: arguments_.classes });
        const plan = createPurgePlan(state, { classes: arguments_.classes as (PurgeClass | "all")[], from: arguments_.from, through: arguments_.through });
        await writePlan(root, plan);
        return execution(EXIT_CODES.success, successEnvelope(command, { preview_digest: plan.plan_digest, plan, warning: "Applying this plan makes the selected history no longer rebuildable" }), `Purge preview ${plan.plan_digest}.`);
      }
      if (command === "events.rebuild") {
        if (!arguments_.from || !arguments_.through) return fail(command, EXIT_CODES.needsInput, "NEEDS_INPUT", "Rebuild requires explicit --from and --through dates");
        const metrics = await readMetrics();
        const registry = new Map(metrics.map((metric) => [sha256Digest(metric), metric]));
        const rebuilt = rebuildRollups(state.daily_rollups, state.events, state.scores, registry, arguments_.from, arguments_.through);
        await persistRollups(root, rebuilt.daily, rebuilt.weekly, state);
        return execution(EXIT_CODES.success, successEnvelope(command, rebuilt), `Rebuilt ${rebuilt.daily.length} daily and ${rebuilt.weekly.length} weekly rollups; sealed history was preserved.`);
      }
      return fail(command, EXIT_CODES.invalid, "INVALID_INPUT", "Unsupported events command");
    }, { lockTimeoutMs: 250 });
  } catch (error) {
    if ((error as { code?: string }).code === "LOCK_TIMEOUT") return fail(command, EXIT_CODES.temporary, "TEMPORARY_LOCK_FAILURE", "Event state is currently locked", null, true);
    if ((error as { code?: string }).code === "PATH_ESCAPE" || (error as { message?: string }).message === "PATH_ESCAPE") {
      return fail(command, EXIT_CODES.denied, "PRIVACY_DENIED", "Unsafe event state path");
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/SCHEMA_INVALID/.test(message)) return fail(command, EXIT_CODES.invalid, "SCHEMA_INVALID", "Record failed validation");
    return fail(command, EXIT_CODES.temporary, "TEMPORARY_FAILURE", "Event command could not complete", { cause: message }, true);
  }
}

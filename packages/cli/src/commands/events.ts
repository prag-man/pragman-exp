import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendDurable,
  applyExportPlan,
  applyRetentionPlan,
  canonicalJson,
  calculateRoutingMetrics,
  createEvalCandidateDecision,
  createEventValidators,
  createExportPlan,
  createLifecycleIndex,
  createPurgePlan,
  loadEventSettings,
  readPartition,
  rebuildRollups,
  resolveStateRoot,
  sha256Digest,
  type EvalCandidate,
  type EvalCandidateApproval,
  type ExplicitPurgePlan,
  type ExportPlan,
  type PurgeClass,
  type RetentionState,
  type SkillEvent,
  type SkillMetric,
  type SkillRollup,
  type SkillScore,
} from "../../../events/src/index.ts";
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

async function partitionDates(root: string, directory: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)).map((entry) => entry.name.slice(0, 10)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readRecordType<T>(root: string, directory: string): Promise<T[]> {
  const dates = await partitionDates(root, directory);
  const result: T[] = [];
  for (const date of dates) {
    const partition = await readPartition<T>(root, directory as "skill-events" | "scores" | "eval-candidates" | "candidate-approvals", date);
    result.push(...partition.records);
  }
  return result;
}

async function readRollups(root: string, period: "daily" | "weekly"): Promise<SkillRollup[]> {
  const directory = join(root, "rollups", period);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const result: SkillRollup[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const value = JSON.parse(await readFile(join(directory, entry.name), "utf8")) as SkillRollup | SkillRollup[];
      result.push(...(Array.isArray(value) ? value : [value]));
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function loadRetentionState(configuredRoot: string): Promise<RetentionState> {
  const root = await resolveStateRoot(configuredRoot);
  const quarantine = [];
  try {
    const entries = await readdir(join(root, "quarantine"), { withFileTypes: true });
    for (const entry of entries) if (entry.isFile()) {
      const metadata = await stat(join(root, "quarantine", entry.name));
      quarantine.push({ quarantine_id: entry.name, timestamp: metadata.mtime.toISOString() });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    events: await readRecordType<SkillEvent>(root, "skill-events"),
    scores: await readRecordType<SkillScore>(root, "scores"),
    candidates: await readRecordType<EvalCandidate>(root, "eval-candidates"),
    approvals: await readRecordType<EvalCandidateApproval>(root, "candidate-approvals"),
    daily_rollups: await readRollups(root, "daily"),
    weekly_rollups: await readRollups(root, "weekly"),
    quarantine,
  };
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
  const path = join(root, "plans", `${plan.plan_digest}.json`);
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o600);
  try { await handle.write(`${canonicalJson(plan)}\n`); await handle.sync(); } finally { await handle.close(); }
}

async function readPlan<T>(root: string, digest: string): Promise<T | null> {
  if (!/^[a-f0-9]{64}$/.test(digest)) return null;
  try { return JSON.parse(await readFile(join(root, "plans", `${digest}.json`), "utf8")) as T; }
  catch { return null; }
}

async function withMutationLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(root, ".events-mutation.lock");
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("LOCK_BUSY"), { code: "LOCK_BUSY" }); throw error; }
  try { return await operation(); } finally { await handle.close(); await unlink(lockPath).catch(() => undefined); }
}

async function assertMutationLockAvailable(root: string): Promise<void> {
  try {
    await stat(join(root, ".events-mutation.lock"));
    throw Object.assign(new Error("LOCK_BUSY"), { code: "LOCK_BUSY" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function replaceRecordType<T extends { timestamp: string }>(root: string, directory: string, values: readonly T[]): Promise<void> {
  const target = join(root, directory);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(target, { recursive: true });
  const existing = await readdir(target, { withFileTypes: true });
  for (const entry of existing) if (entry.isFile() && entry.name.endsWith(".jsonl")) await unlink(join(target, entry.name));
  const groups = new Map<string, T[]>();
  for (const value of values) { const date = value.timestamp.slice(0, 10); const group = groups.get(date) ?? []; group.push(value); groups.set(date, group); }
  for (const [date, records] of groups) await writeFile(join(target, `${date}.jsonl`), `${records.map(canonicalJson).join("\n")}\n`, { mode: 0o600 });
}

async function persistPurgedState(root: string, state: RetentionState): Promise<void> {
  await replaceRecordType(root, "skill-events", state.events);
  await replaceRecordType(root, "scores", state.scores);
  await replaceRecordType(root, "eval-candidates", state.candidates);
  await replaceRecordType(root, "candidate-approvals", state.approvals);
  const keepQuarantine = new Set(state.quarantine.map((entry) => entry.quarantine_id));
  try { for (const entry of await readdir(join(root, "quarantine"), { withFileTypes: true })) if (entry.isFile() && !keepQuarantine.has(entry.name)) await unlink(join(root, "quarantine", entry.name)); } catch { /* absent */ }
}

async function persistRollups(root: string, daily: readonly SkillRollup[], weekly: readonly SkillRollup[]): Promise<void> {
  for (const [period, values] of [["daily", daily], ["weekly", weekly]] as const) {
    const directory = join(root, "rollups", period);
    await mkdir(directory, { recursive: true });
    const groups = new Map<string, SkillRollup[]>();
    for (const rollup of values) {
      const key = period === "daily" ? rollup.period_start.slice(0, 10) : rollup.period_start.slice(0, 10);
      const group = groups.get(key) ?? []; group.push(rollup); groups.set(key, group);
    }
    const expected = new Set([...groups.keys()].map((key) => `${key}.json`));
    for (const [key, records] of groups) {
      const target = join(directory, `${key}.json`);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, `${canonicalJson(records)}\n`, { mode: 0o600 });
      await rename(temporary, target);
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json") && !expected.has(entry.name)) await unlink(join(directory, entry.name));
    }
  }
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
      const state = await loadRetentionState(root);
      const lifecycle = indexState(state);
      if (command === "events.record") {
        const validation = createEventValidators().event(input.value);
        if (!validation.ok) return fail(command, EXIT_CODES.invalid, validation.code, "Event record failed validation");
        const lifecycleResult = lifecycle.addEvent(validation.value);
        if (!lifecycleResult.ok) return fail(command, EXIT_CODES.invalid, lifecycleResult.reason, "Event lifecycle rejected the record");
        await assertMutationLockAvailable(root);
        const appended = await appendDurable(root, "skill-events", validation.value);
        const data = { recorded: appended.status === "appended" || appended.status === "duplicate", status: appended.status, digest: appended.digest };
        return execution(EXIT_CODES.success, successEnvelope(command, data), `Event ${appended.status}.`);
      }
      const metrics = await readMetrics();
      const score = input.value as Partial<SkillScore>;
      const metric = metrics.find((candidate) => sha256Digest(candidate) === score.metric_definition_digest);
      if (!metric) return fail(command, EXIT_CODES.invalid, "UNKNOWN_METRIC_DEFINITION", "Score references an unknown metric definition");
      const validation = createEventValidators(metrics).score(input.value, metric);
      if (!validation.ok) return fail(command, EXIT_CODES.invalid, validation.code, "Score record failed validation");
      const lifecycleResult = lifecycle.addScore(validation.value);
      if (!lifecycleResult.ok) return fail(command, EXIT_CODES.invalid, lifecycleResult.reason, "Score lifecycle rejected the record");
      await assertMutationLockAvailable(root);
      const appended = await appendDurable(root, "scores", validation.value);
      return execution(EXIT_CODES.success, successEnvelope(command, { recorded: appended.status !== "quarantined", status: appended.status, digest: appended.digest }), `Score ${appended.status}.`);
    }

    const state = await loadRetentionState(root);
    if (command === "events.list") {
      const data = { events: state.events, scores: state.scores };
      return execution(EXIT_CODES.success, successEnvelope(command, data), `${state.events.length} events; ${state.scores.length} scores.`);
    }
    if (command === "events.summary") {
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
      const lifecycleResult = indexState(state).addApproval(decision);
      if (!lifecycleResult.ok) return fail(command, EXIT_CODES.invalid, lifecycleResult.reason, "Candidate decision was rejected");
      await assertMutationLockAvailable(root);
      const appended = await appendDurable(root, "candidate-approvals", decision);
      return execution(EXIT_CODES.success, successEnvelope(command, { decided: appended.status !== "quarantined", status: appended.status, decision }), `Candidate ${decision.decision}.`);
    }
    if (command === "events.export") {
      if (arguments_.applyDigest) {
        const plan = await readPlan<ExportPlan>(root, arguments_.applyDigest);
        if (!plan || plan.plan_digest !== arguments_.applyDigest) return fail(command, EXIT_CODES.denied, "STALE_PREVIEW", "Export preview digest is missing or invalid");
        const applied = await withMutationLock(root, async () => applyExportPlan(plan, state));
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
        const applied = await applyRetentionPlan(plan, state, {
          now: () => new Date(),
          withMutationLock: (operation) => withMutationLock(root, async () => {
            const result = await operation();
            if (typeof result === "object" && result !== null && "applied" in result
              && (result as { applied: boolean }).applied && "state" in result) {
              await persistPurgedState(root, (result as { state: RetentionState }).state);
            }
            return result;
          }),
          sealAndVerifyDaily: async () => true, recomputeWeekly: async () => true,
        });
        if (!applied.applied) return fail(command, applied.reason === "PLAN_EXPIRED" ? EXIT_CODES.needsInput : EXIT_CODES.denied, applied.reason, "Purge preview can no longer be applied");
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
      await withMutationLock(root, () => persistRollups(root, rebuilt.daily, rebuilt.weekly));
      return execution(EXIT_CODES.success, successEnvelope(command, rebuilt), `Rebuilt ${rebuilt.daily.length} daily and ${rebuilt.weekly.length} weekly rollups; sealed history was preserved.`);
    }
    return fail(command, EXIT_CODES.invalid, "INVALID_INPUT", "Unsupported events command");
  } catch (error) {
    if ((error as { code?: string }).code === "LOCK_BUSY") return fail(command, EXIT_CODES.temporary, "TEMPORARY_LOCK_FAILURE", "Event state is currently locked", null, true);
    const message = error instanceof Error ? error.message : String(error);
    if (/SCHEMA_INVALID/.test(message)) return fail(command, EXIT_CODES.invalid, "SCHEMA_INVALID", "Record failed validation");
    return fail(command, EXIT_CODES.temporary, "TEMPORARY_FAILURE", "Event command could not complete", { cause: message }, true);
  }
}

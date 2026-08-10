import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { link, lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareAblation,
  canonicalJson,
  createEventValidators,
  loadEventSettings,
  observeSkillEvent,
  resolveStateRoot,
  sha256Digest,
  type AblationTrial,
  type ObservationResult,
  type SkillEvent,
  type SkillMetric,
} from "../../../events/src/index.ts";
import { createLocalBestEffortDependencies } from "../../../events/src/store.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution, CommandIo } from "./events.ts";

const DEFAULT_EVENT_STATE_ROOT = join(homedir(), ".pragman", "state", "events");
const MAX_RUNNER_OUTPUT_BYTES = 1024 * 1024;

async function input(arguments_: CliArguments, io: CommandIo): Promise<unknown> {
  let text: string;
  try {
    text = arguments_.file ? await readFile(arguments_.file, "utf8") : await io.readStdin();
  } catch {
    throw Object.assign(new Error("Unable to read selected JSON input"), { code: "INVALID_INPUT" });
  }
  if (text.trim().length === 0) throw Object.assign(new Error("JSON input is required on stdin or through --file"), { code: "NEEDS_INPUT" });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw Object.assign(new Error("Input must be valid JSON"), { code: "INVALID_INPUT" });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function parseCompareInput(value: unknown): { trials: AblationTrial[]; metric: SkillMetric; registry: Map<string, SkillMetric> } {
  if (!isPlainObject(value) || !exactKeys(value, ["metric", "trials"]) || !Array.isArray(value.trials)) {
    throw new TypeError("Compare input must contain only metric and trials");
  }
  const validation = createEventValidators().metric(value.metric);
  if (!validation.ok) throw new TypeError("Registered metric definition is invalid");
  const metric = validation.value;
  const digest = sha256Digest(metric);
  const trials = value.trials as AblationTrial[];
  if (trials.some((trial) => !isPlainObject(trial) || trial.metric_definition_digest !== digest)) {
    throw new TypeError("Every trial must reference the registered metric definition digest");
  }
  return { trials, metric, registry: new Map([[digest, metric]]) };
}

interface EvalRunDescriptor {
  scenario_file: string;
  observed_file: string;
  candidate_digest?: string;
  evidence_id?: string;
}

const RUN_DESCRIPTOR_FIELDS = ["scenario_file", "observed_file", "candidate_digest", "evidence_id"] as const;
const SAFE_EVIDENCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseRunDescriptor(value: unknown): EvalRunDescriptor {
  if (!isPlainObject(value) || Object.keys(value).some((field) => !(RUN_DESCRIPTOR_FIELDS as readonly string[]).includes(field))
    || !("scenario_file" in value) || !("observed_file" in value)) {
    throw new TypeError("Eval run input must use the exact file descriptor schema");
  }
  for (const field of ["scenario_file", "observed_file"] as const) {
    const selected = value[field];
    if (typeof selected !== "string" || selected.length < 1 || selected.length > 4096 || selected.includes("\0")) {
      throw new TypeError("Eval run file descriptors are invalid");
    }
  }
  if (value.candidate_digest !== undefined && (typeof value.candidate_digest !== "string" || !SHA256.test(value.candidate_digest))) {
    throw new TypeError("Eval candidate digest is invalid");
  }
  if (value.evidence_id !== undefined && (typeof value.evidence_id !== "string" || value.evidence_id.length > 96
    || !SAFE_EVIDENCE_ID.test(value.evidence_id))) {
    throw new TypeError("Eval evidence id is invalid");
  }
  return value as unknown as EvalRunDescriptor;
}

async function readSelectedJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new TypeError("Selected evaluation input is unavailable or invalid");
  }
}

export async function resolveBundledEvalRunner(moduleUrl: string = import.meta.url): Promise<string> {
  let cursor = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const candidate = join(cursor, "scripts", "run-evals.mjs");
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Source and packed dist layouts place this command at different depths.
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("BUNDLED_RUNNER_UNAVAILABLE");
    cursor = parent;
  }
}

function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function evalRunEvent(invocationId: string, eventType: "invoked" | "completed", startedAt: number): SkillEvent {
  const completed = eventType === "completed";
  return {
    schema_version: 1,
    event_id: uuidV7(),
    invocation_id: invocationId,
    timestamp: new Date().toISOString(),
    event_type: eventType,
    skill_id: "pragman:eval-run",
    skill_version: "1",
    skill_digest: sha256Digest("pragman-eval-run-v1"),
    skill_type: "capability",
    host: "cli",
    host_version: "1",
    model: "local-eval",
    model_version: "1",
    harness_version: "1",
    invocation_mode: "host",
    session_id: null,
    route_id: null,
    eval_id: null,
    case_id: null,
    trial_id: null,
    provider: null,
    ablation_arm: "production",
    trigger_expected: null,
    trigger_actual: true,
    provider_digest: null,
    eval_corpus_digest: null,
    trial_policy_digest: null,
    status: completed ? "succeeded" : null,
    outcome_code: null,
    duration_ms: completed ? Math.max(0, Date.now() - startedAt) : 0,
    tool_calls: 0,
    retries: 0,
    rework_cycles: 0,
    verification_checks: 0,
    verification_passes: 0,
    observation_source: "cli",
    source_aliases: [],
    storage_scope: "local",
    append_only: true,
  };
}

export async function observeEvalRunLifecycleEvent(
  arguments_: Pick<CliArguments, "config" | "stateRoot">,
  event: SkillEvent,
): Promise<ObservationResult> {
  const settings = await loadEventSettings(arguments_.config);
  if (!settings.ok || !settings.local_events) {
    return { recorded: false, reason: settings.ok ? "DISABLED" : "CONFIG_INVALID" };
  }
  const dependencies = await createLocalBestEffortDependencies(arguments_.stateRoot ?? DEFAULT_EVENT_STATE_ROOT);
  return observeSkillEvent(settings, event, dependencies);
}

type EvalLifecycleObserver = (event: SkillEvent) => Promise<ObservationResult>;

function observationWarning(result: ObservationResult): string | null {
  return result.recorded || result.reason === "DISABLED" ? null : `EVENT_OBSERVATION_${result.reason}`;
}

const SAFE_EVIDENCE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const KNOWN_SECRET = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})/;
const COMPARISON_IDENTITY_FIELDS = [
  "eval_id", "eval_corpus_digest", "trial_policy_digest", "skill_type", "skill_id", "skill_version",
  "skill_digest", "provider", "provider_digest", "environment_digest", "host", "host_version", "model",
  "model_version", "harness_version", "metric_id", "metric_definition_digest", "grader_id", "grader_version",
  "grader_digest", "rubric_digest",
] as const;
const COMPARISON_DIGEST_FIELDS = new Set([
  "eval_corpus_digest", "trial_policy_digest", "skill_digest", "provider_digest", "environment_digest",
  "metric_definition_digest", "grader_digest", "rubric_digest",
]);

function safeEvidenceToken(value: unknown, maximum = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && SAFE_EVIDENCE_TOKEN.test(value) && !KNOWN_SECRET.test(value);
}

function safeCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safeDelta(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function validRunnerArm(value: unknown): boolean {
  if (!isPlainObject(value) || !exactKeys(value, [
    "passed", "verified_success", "metric_value", "utility", "duration_ms", "retries", "rework_cycles", "tool_calls",
  ])) return false;
  const metricValue = value.metric_value;
  return typeof value.passed === "boolean"
    && typeof value.verified_success === "boolean"
    && (typeof metricValue === "boolean" || (typeof metricValue === "number" && Number.isFinite(metricValue)) || safeEvidenceToken(metricValue, 64))
    && typeof value.utility === "number" && Number.isFinite(value.utility) && value.utility >= 0 && value.utility <= 1
    && [value.duration_ms, value.retries, value.rework_cycles, value.tool_calls].every(safeCounter);
}

function validEfficiencyDelta(value: unknown, integersOnly = false): boolean {
  return isPlainObject(value) && exactKeys(value, ["duration_ms", "retries", "rework_cycles", "tool_calls"])
    && [value.duration_ms, value.retries, value.rework_cycles, value.tool_calls].every((entry) => integersOnly
      ? safeDelta(entry)
      : typeof entry === "number" && Number.isFinite(entry));
}

function validRunnerPair(value: unknown): boolean {
  if (!isPlainObject(value) || !exactKeys(value, [
    "case_id", "trial_id", "skill_on", "skill_off", "metric_delta", "utility_delta", "efficiency_delta",
  ])) return false;
  return safeEvidenceToken(value.case_id)
    && safeEvidenceToken(value.trial_id)
    && validRunnerArm(value.skill_on)
    && validRunnerArm(value.skill_off)
    && (value.metric_delta === null || (typeof value.metric_delta === "number" && Number.isFinite(value.metric_delta)))
    && typeof value.utility_delta === "number" && Number.isFinite(value.utility_delta)
    && value.utility_delta >= -1 && value.utility_delta <= 1
    && validEfficiencyDelta(value.efficiency_delta, true);
}

function validComparisonIdentity(value: unknown): boolean {
  if (!isPlainObject(value) || !exactKeys(value, COMPARISON_IDENTITY_FIELDS)) return false;
  return COMPARISON_IDENTITY_FIELDS.every((field) => COMPARISON_DIGEST_FIELDS.has(field)
    ? typeof value[field] === "string" && SHA256.test(value[field])
    : safeEvidenceToken(value[field]));
}

export function parseBundledRunnerEvidence(stdout: string): Record<string, unknown> {
  if (Buffer.byteLength(stdout, "utf8") > MAX_RUNNER_OUTPUT_BYTES) throw new TypeError("Runner evidence exceeded its bound");
  let evidence: unknown;
  try { evidence = JSON.parse(stdout) as unknown; } catch { throw new TypeError("Runner evidence is invalid"); }
  if (!isPlainObject(evidence) || evidence.schema_version !== 2 || evidence.mode !== "skill-eval"
    || (evidence.status !== "COMPARABLE" && evidence.status !== "INCOMPARABLE")) {
    throw new TypeError("Runner evidence is invalid");
  }
  if (evidence.status === "INCOMPARABLE") {
    if (!exactKeys(evidence, ["schema_version", "mode", "status", "reasons"])
      || !Array.isArray(evidence.reasons) || evidence.reasons.length < 1 || evidence.reasons.length > 32
      || !evidence.reasons.every((reason) => safeEvidenceToken(reason, 64))) {
      throw new TypeError("Runner evidence is invalid");
    }
    return evidence;
  }
  if (!exactKeys(evidence, [
    "schema_version", "mode", "status", "comparison_identity", "arms", "trials_per_case", "pair_count",
    "skill_on_pass_rate", "skill_off_pass_rate", "utility_lift", "verified_success_lift", "efficiency_delta",
    "pairs", "significance", "significance_reason",
  ]) || !validComparisonIdentity(evidence.comparison_identity)
    || !Array.isArray(evidence.arms) || evidence.arms.length !== 2
    || evidence.arms[0] !== "skill-off" || evidence.arms[1] !== "skill-on"
    || !isPlainObject(evidence.trials_per_case)
    || Object.keys(evidence.trials_per_case).length < 1 || Object.keys(evidence.trials_per_case).length > 64
    || !Object.entries(evidence.trials_per_case).every(([caseId, count]) => safeEvidenceToken(caseId) && safeCounter(count) && count >= 2 && count <= 6)
    || !safeCounter(evidence.pair_count) || evidence.pair_count < 1 || evidence.pair_count > 384
    || !Array.isArray(evidence.pairs) || evidence.pairs.length !== evidence.pair_count || !evidence.pairs.every(validRunnerPair)
    || ![evidence.skill_on_pass_rate, evidence.skill_off_pass_rate].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
    || ![evidence.utility_lift, evidence.verified_success_lift].every((value) => typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1)
    || !validEfficiencyDelta(evidence.efficiency_delta)
    || (evidence.significance_reason !== null && evidence.significance_reason !== "MINIMUM_20_PAIRS_REQUIRED")) {
    throw new TypeError("Runner evidence is invalid");
  }
  if (evidence.significance !== null) {
    const significance = evidence.significance;
    if (!isPlainObject(significance) || !exactKeys(significance, ["confidence_level", "lower", "upper", "significant"])
      || significance.confidence_level !== 0.95 || typeof significance.significant !== "boolean"
      || ![significance.lower, significance.upper].every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new TypeError("Runner evidence is invalid");
    }
  }
  return evidence;
}

export function validateBundledRunnerEvidence(value: unknown): Record<string, unknown> {
  return parseBundledRunnerEvidence(canonicalJson(value));
}

export interface EvalEvidenceArtifact {
  schema_version: 1;
  artifact_type: "pragman-eval-evidence";
  evidence_id: string;
  created_at: string;
  candidate_digest: string | null;
  runner_version: 2;
  evidence: Record<string, unknown>;
}

function parseEvalEvidenceArtifact(value: unknown, expectedEvidenceId: string): EvalEvidenceArtifact {
  const timestamp = isPlainObject(value) && typeof value.created_at === "string" ? new Date(value.created_at) : null;
  if (!isPlainObject(value) || !exactKeys(value, [
    "schema_version", "artifact_type", "evidence_id", "created_at", "candidate_digest", "runner_version", "evidence",
  ]) || value.schema_version !== 1 || value.artifact_type !== "pragman-eval-evidence"
    || value.evidence_id !== expectedEvidenceId || value.runner_version !== 2
    || timestamp === null || !Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value.created_at
    || (value.candidate_digest !== null && (typeof value.candidate_digest !== "string" || !SHA256.test(value.candidate_digest)))) {
    throw Object.assign(new Error("Evaluation artifact is invalid"), { code: "EVALUATION_FAILED" });
  }
  const evidence = validateBundledRunnerEvidence(value.evidence);
  return { ...value, evidence } as EvalEvidenceArtifact;
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function evidenceDirectory(configuredRoot: string): Promise<string> {
  const root = await resolveStateRoot(configuredRoot);
  const directory = join(root, "eval-evidence");
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw Object.assign(new Error("Unsafe evidence directory"), { code: "OUTPUT_UNAVAILABLE" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { mode: 0o700 });
  }
  const resolved = await realpath(directory);
  if (!contained(root, resolved)) throw Object.assign(new Error("Unsafe evidence directory"), { code: "OUTPUT_UNAVAILABLE" });
  return resolved;
}

export async function loadEvalEvidenceArtifact(
  configuredRoot: string,
  evidenceId: string,
): Promise<{ artifact: EvalEvidenceArtifact; artifactDigest: string }> {
  if (evidenceId.length > 96 || !SAFE_EVIDENCE_ID.test(evidenceId)) {
    throw Object.assign(new Error("Evaluation evidence id is invalid"), { code: "EVALUATION_FAILED" });
  }
  const root = await resolveStateRoot(configuredRoot);
  const directory = join(root, "eval-evidence");
  let directoryMetadata;
  try { directoryMetadata = await lstat(directory); }
  catch { throw Object.assign(new Error("Evaluation evidence is unavailable"), { code: "EVALUATION_FAILED" }); }
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw Object.assign(new Error("Evaluation evidence is unavailable"), { code: "EVALUATION_FAILED" });
  }
  const resolvedDirectory = await realpath(directory);
  if (!contained(root, resolvedDirectory)) throw Object.assign(new Error("Evaluation evidence is unavailable"), { code: "EVALUATION_FAILED" });
  const target = join(resolvedDirectory, `${evidenceId}.json`);
  let metadata;
  try { metadata = await lstat(target); }
  catch { throw Object.assign(new Error("Evaluation evidence is unavailable"), { code: "EVALUATION_FAILED" }); }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_RUNNER_OUTPUT_BYTES * 2) {
    throw Object.assign(new Error("Evaluation evidence is unavailable"), { code: "EVALUATION_FAILED" });
  }
  const resolvedTarget = await realpath(target);
  if (!contained(resolvedDirectory, resolvedTarget)) throw Object.assign(new Error("Evaluation evidence is unavailable"), { code: "EVALUATION_FAILED" });
  let value: unknown;
  try { value = JSON.parse(await readFile(resolvedTarget, "utf8")) as unknown; }
  catch { throw Object.assign(new Error("Evaluation evidence is invalid"), { code: "EVALUATION_FAILED" }); }
  const artifact = parseEvalEvidenceArtifact(value, evidenceId);
  return { artifact, artifactDigest: sha256Digest(artifact) };
}

async function writeImmutableEvidence(configuredRoot: string, evidenceId: string, bytes: string): Promise<void> {
  const directory = await evidenceDirectory(configuredRoot);
  const target = join(directory, `${evidenceId}.json`);
  try {
    await lstat(target);
    throw Object.assign(new Error("Evaluation evidence already exists"), { code: "OUTPUT_ALREADY_EXISTS" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(directory, `.${evidenceId}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (await realpath(directory) !== directory) throw Object.assign(new Error("Unsafe evidence directory"), { code: "OUTPUT_UNAVAILABLE" });
    await link(temporary, target);
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw Object.assign(new Error("Evaluation evidence already exists"), { code: "OUTPUT_ALREADY_EXISTS" });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function executeEvalCommand(
  arguments_: CliArguments,
  io: CommandIo,
  observe: EvalLifecycleObserver = (event) => observeEvalRunLifecycleEvent(arguments_, event),
): Promise<CommandExecution> {
  try {
    const value = await input(arguments_, io);
    if (arguments_.command === "eval.compare") {
      const compareInput = parseCompareInput(value);
      const comparison = compareAblation(compareInput.trials, compareInput.registry);
      return {
        exitCode: EXIT_CODES.success,
        envelope: successEnvelope(arguments_.command, comparison),
        human: comparison.status === "COMPARABLE"
          ? `${comparison.pair_count} paired trials compared.`
          : `Evidence is incomparable: ${comparison.reasons.join(", ")}.`,
      };
    }

    const descriptor = parseRunDescriptor(value);
    const scenario = await readSelectedJson(descriptor.scenario_file);
    const observed = await readSelectedJson(descriptor.observed_file);
    const runner = await resolveBundledEvalRunner();
    const invocationId = uuidV7();
    const startedAt = Date.now();
    const warnings: string[] = [];
    const invokedObservation = await observe(evalRunEvent(invocationId, "invoked", startedAt)).catch(() => ({ recorded: false, reason: "IO_ERROR" } as const));
    const invokedWarning = observationWarning(invokedObservation);
    if (invokedWarning) warnings.push(invokedWarning);
    const child = spawnSync(process.execPath, [runner, "--mode", "skill-eval", "--stdio"], {
      encoding: "utf8",
      input: JSON.stringify({ scenario, observed }),
      maxBuffer: MAX_RUNNER_OUTPUT_BYTES,
    });
    if (child.status !== 0) {
      const invalid = child.status === 2;
      return {
        exitCode: invalid ? EXIT_CODES.invalid : EXIT_CODES.unavailable,
        envelope: errorEnvelope(
          arguments_.command,
          invalid ? "INVALID_INPUT" : "EVAL_FAILED",
          "Local evaluation runner failed",
          { diagnostic: invalid ? "RUNNER_REJECTED_INPUT" : "RUNNER_EXECUTION_FAILED", status: child.status },
          !invalid,
          warnings,
        ),
        human: "Local evaluation runner failed.",
        stderr: true,
      };
    }
    const evidence = parseBundledRunnerEvidence(child.stdout);
    const evidenceId = descriptor.evidence_id ?? `eval-${uuidV7()}`;
    const artifact: EvalEvidenceArtifact = {
      schema_version: 1,
      artifact_type: "pragman-eval-evidence",
      evidence_id: evidenceId,
      created_at: new Date().toISOString(),
      candidate_digest: descriptor.candidate_digest ?? null,
      runner_version: 2,
      evidence,
    };
    const artifactDigest = sha256Digest(artifact);
    try { await writeImmutableEvidence(arguments_.stateRoot ?? DEFAULT_EVENT_STATE_ROOT, evidenceId, `${canonicalJson(artifact)}\n`); }
    catch (error) {
      const exists = (error as { code?: string }).code === "OUTPUT_ALREADY_EXISTS";
      return {
        exitCode: exists ? EXIT_CODES.denied : EXIT_CODES.unavailable,
        envelope: errorEnvelope(arguments_.command, exists ? "OUTPUT_ALREADY_EXISTS" : "OUTPUT_UNAVAILABLE", exists
          ? "Evaluation evidence already exists"
          : "Evaluation output could not be written", { diagnostic: exists ? "IMMUTABLE_TARGET_EXISTS" : "OUTPUT_WRITE_FAILED" }, !exists, warnings),
        human: exists ? "Evaluation evidence already exists." : "Evaluation output could not be written.",
        stderr: true,
      };
    }
    if (invokedObservation.recorded) {
      const completedObservation = await observe(evalRunEvent(invocationId, "completed", startedAt)).catch(() => ({ recorded: false, reason: "IO_ERROR" } as const));
      const completedWarning = observationWarning(completedObservation);
      if (completedWarning) warnings.push(completedWarning);
    }
    return {
      exitCode: EXIT_CODES.success,
      envelope: successEnvelope(arguments_.command, { runner_version: 2, evidence_id: evidenceId, artifact_digest: artifactDigest, evidence }, warnings),
      human: "Local skill evaluation run completed.",
    };
  } catch (error) {
    const needsInput = (error as { code?: string }).code === "NEEDS_INPUT";
    const message = needsInput ? "JSON input is required on stdin or through --file" : "Evaluation input is invalid";
    return {
      exitCode: needsInput ? EXIT_CODES.needsInput : EXIT_CODES.invalid,
      envelope: errorEnvelope(arguments_.command, needsInput ? "NEEDS_INPUT" : "INVALID_INPUT", message),
      human: message,
      stderr: true,
    };
  }
}

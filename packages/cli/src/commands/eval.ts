import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { compareAblation, type AblationTrial } from "../../../events/src/index.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution, CommandIo } from "./events.ts";

async function input(arguments_: CliArguments, io: CommandIo): Promise<unknown> {
  const text = arguments_.file ? await readFile(arguments_.file, "utf8") : await io.readStdin();
  if (text.trim().length === 0) throw Object.assign(new Error("JSON input is required on stdin or through --file"), { code: "NEEDS_INPUT" });
  return JSON.parse(text) as unknown;
}

const TRIAL_KEYS = new Set([
  "arm", "eval_id", "eval_corpus_digest", "trial_policy_digest", "case_id", "trial_id", "skill_digest",
  "provider", "provider_digest", "host", "host_version", "model", "model_version", "harness_version",
  "metric_id", "metric_definition_digest", "grader_id", "grader_version", "rubric_digest", "raw_value",
  "utility", "passed", "verified_success", "duration_ms", "retries", "rework_cycles", "tool_calls",
]);
const STRING_TRIAL_KEYS = [...TRIAL_KEYS].filter((key) => ![
  "arm", "raw_value", "utility", "passed", "verified_success", "duration_ms", "retries", "rework_cycles", "tool_calls",
].includes(key));

function isContentFreeTrial(value: unknown): value is AblationTrial {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== TRIAL_KEYS.size || Object.keys(record).some((key) => !TRIAL_KEYS.has(key))) return false;
  return (record.arm === "skill-on" || record.arm === "skill-off")
    && STRING_TRIAL_KEYS.every((key) => typeof record[key] === "string" && (record[key] as string).length > 0)
    && ["utility", "duration_ms", "retries", "rework_cycles", "tool_calls"].every((key) => typeof record[key] === "number" && Number.isFinite(record[key]))
    && typeof record.passed === "boolean" && typeof record.verified_success === "boolean"
    && (["boolean", "number", "string"].includes(typeof record.raw_value));
}

export async function executeEvalCommand(arguments_: CliArguments, io: CommandIo): Promise<CommandExecution> {
  try {
    const value = await input(arguments_, io);
    if (arguments_.command === "eval.compare") {
      const trials = Array.isArray(value) ? value : (value as { trials?: unknown }).trials;
      if (!Array.isArray(trials)) throw new TypeError("Paired trial evidence is required");
      if (!trials.every(isContentFreeTrial)) throw new TypeError("Paired trial evidence must use the exact content-free schema");
      const comparison = compareAblation(trials as AblationTrial[]);
      return { exitCode: EXIT_CODES.success, envelope: successEnvelope(arguments_.command, comparison), human: comparison.status === "COMPARABLE" ? `${comparison.pair_count} paired trials compared.` : `Evidence is incomparable: ${comparison.reasons.join(", ")}.` };
    }
    const descriptor = value as { scenario_file?: unknown; observed_file?: unknown; output_file?: unknown };
    if (typeof descriptor.scenario_file !== "string" || typeof descriptor.observed_file !== "string" || typeof descriptor.output_file !== "string") throw new TypeError("eval run requires scenario_file, observed_file, and output_file in JSON input");
    const runner = arguments_.runner ?? join(process.cwd(), "scripts", "run-evals.mjs");
    const child = spawnSync(process.execPath, [runner, descriptor.scenario_file, "--observed", descriptor.observed_file, "--output", descriptor.output_file], { encoding: "utf8" });
    if (child.status !== 0) return { exitCode: child.status === 2 ? EXIT_CODES.invalid : EXIT_CODES.unavailable, envelope: errorEnvelope(arguments_.command, child.status === 2 ? "INVALID_INPUT" : "EVAL_FAILED", "Local evaluation runner failed", { stderr: child.stderr.trim() }), human: "Local evaluation runner failed.", stderr: true };
    const evidence = JSON.parse(await readFile(descriptor.output_file, "utf8")) as unknown;
    return { exitCode: EXIT_CODES.success, envelope: successEnvelope(arguments_.command, { runner_version: 1, evidence }), human: "Local evaluation run completed." };
  } catch (error) {
    const needsInput = (error as { code?: string }).code === "NEEDS_INPUT";
    return { exitCode: needsInput ? EXIT_CODES.needsInput : EXIT_CODES.invalid, envelope: errorEnvelope(arguments_.command, needsInput ? "NEEDS_INPUT" : "INVALID_INPUT", error instanceof Error ? error.message : String(error)), human: error instanceof Error ? error.message : String(error), stderr: true };
  }
}

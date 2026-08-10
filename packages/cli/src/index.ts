#!/usr/bin/env node

import { parseArguments } from "./args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "./envelope.ts";
import { executeEventsCommand, type CommandExecution, type CommandIo } from "./commands/events.ts";
import { executeEvalCommand } from "./commands/eval.ts";
import { executeWorkspaceCommand } from "./commands/workspace.ts";
import { executeInitCommand } from "./commands/init.ts";
import { executeScanCommand } from "./commands/scan.ts";
import { executeDoctorCommand } from "./commands/doctor.ts";
import { executeProvidersCommand } from "./commands/providers.ts";
import { executeProviderSettingsCommand } from "./commands/provider-settings.ts";
import { executeRouteCommand } from "./commands/route.ts";
import { executeTuneCommand } from "./commands/tune.ts";
import { executeChangesCommand } from "./commands/changes.ts";
import { executeHistoryPurgeCommand, executeSessionsCommand } from "./commands/sessions.ts";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_NAME = "@prag-man/pragman-exp";

export function resolvePackageVersion(moduleUrl: string = import.meta.url): string {
  let directory = dirname(fileURLToPath(moduleUrl));
  while (true) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        metadata.name === PACKAGE_NAME &&
        typeof metadata.version === "string" &&
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)
      ) {
        return metadata.version;
      }
    } catch {
      // Continue to the parent; source, dist, and packed layouts have different depths.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Unable to locate ${PACKAGE_NAME} package metadata`);
}

const VERSION = resolvePackageVersion();

const COMMANDS = [
  "init", "scan", "doctor", "route", "tune", "workspace add|edit|list|link|unlink|validate",
  "providers list|inspect|prefer|trust", "sessions scan|analyze|purge", "changes list|preview|apply|rollback",
  "history purge", "eval [run|compare]", "events record|score|list|summary|rebuild|export|purge|candidates list|candidates decide",
];

const COMMAND_USAGE: Record<string, string> = {
  init: "pragman init [--file PROFILE.json] [--config DIR] [--project-root DIR] [--apply DIGEST]",
  scan: "pragman scan [--project-root DIR]",
  doctor: "pragman doctor [--config DIR] [--project-root DIR]",
  route: "pragman route [--file INPUT.json] [--provider ID] [--host HOST] [--project-root DIR]",
  tune: "pragman tune [--file INPUT.json] [--state-root DIR] [--config DIR] [--apply DIGEST]",
  "workspace add": "pragman workspace add [--file INPUT.json] [--config DIR] [--apply DIGEST]",
  "workspace edit": "pragman workspace edit --workspace ID [--file PATCH.json] [--config DIR] [--apply DIGEST]",
  "workspace list": "pragman workspace list [--config DIR]",
  "workspace link": "pragman workspace link [--file INPUT.json] --project-root DIR [--config DIR] [--apply DIGEST]",
  "workspace unlink": "pragman workspace unlink --project-root DIR [--config DIR] [--apply DIGEST]",
  "workspace validate": "pragman workspace validate [--workspace ID] [--project-root DIR] [--config DIR]",
  "providers list": "pragman providers list [--host HOST] [--project-root DIR] [--config DIR]",
  "providers inspect": "pragman providers inspect --provider ID [--host HOST] [--project-root DIR] [--config DIR]",
  "providers prefer": "pragman providers prefer --provider ID[,ID...] [--config DIR] [--apply DIGEST]",
  "providers trust": "pragman providers trust --provider ID --acknowledge-trust [--config DIR] [--apply DIGEST]",
  "sessions scan": "pragman sessions scan --file SELECTION.json [--state-root DIR]",
  "sessions analyze": "pragman sessions analyze --file SELECTION.json [--state-root DIR]",
  "sessions purge": "pragman sessions purge [--from DATE] [--through DATE] [--class CLASS] [--state-root DIR] [--apply DIGEST]",
  "changes list": "pragman changes list [--config DIR]",
  "changes preview": "pragman changes preview [--file CHANGE.json] [--config DIR]",
  "changes apply": "pragman changes apply [--file CHANGE.json] --apply DIGEST [--config DIR]",
  "changes rollback": "pragman changes rollback --change ID [--config DIR] [--project-root DIR] [--apply DIGEST]",
  "history purge": "pragman history purge [--from DATE] [--through DATE] [--config DIR] [--apply DIGEST]",
  eval: "pragman eval [--file DESCRIPTOR.json] [--state-root DIR]",
  "eval run": "pragman eval run [--file DESCRIPTOR.json] [--state-root DIR]",
  "eval compare": "pragman eval compare [--file DESCRIPTOR.json] [--state-root DIR]",
};

function helpUsage(target?: string): string {
  if (target) return `Usage: ${COMMAND_USAGE[target] ?? `pragman ${target} [options]`}\nInputs default to stdin when --file is supported. Use --json for a stable machine-readable envelope.`;
  return `Usage: pragman <command> [options]\nCommands: ${COMMANDS.join("; ")}\nUse pragman <command> --help for command-specific usage.`;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function run(argv: readonly string[]): number {
  const arguments_ = parseArguments(argv);

  if (arguments_.command === "invalid") {
    const envelope = errorEnvelope(
      "unknown",
      "INVALID_INPUT",
      `Unknown argument${arguments_.invalidArguments.length === 1 ? "" : "s"}: ${arguments_.invalidArguments.join(", ")}`,
      { arguments: arguments_.invalidArguments },
    );
    if (arguments_.json) {
      writeJson(envelope);
    } else {
      process.stderr.write(`${envelope.error.message}\n`);
    }
    return EXIT_CODES.invalid;
  }

  if (arguments_.command === "version") {
    if (arguments_.json) {
      writeJson(successEnvelope("version", { version: VERSION }));
    } else {
      process.stdout.write(`${VERSION}\n`);
    }
    return EXIT_CODES.success;
  }

  const usage = helpUsage(arguments_.helpTarget);
  if (arguments_.json) writeJson(successEnvelope("help", { usage, command: arguments_.helpTarget ?? null }));
  else process.stdout.write(`${usage}\n`);
  return EXIT_CODES.success;
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

function render(result: CommandExecution, json: boolean): void {
  if (json) writeJson(result.envelope);
  else (result.stderr ? process.stderr : process.stdout).write(`${result.human}\n`);
}

export async function runCli(
  argv: readonly string[],
  io: CommandIo = { readStdin: readStandardInput },
): Promise<number> {
  const arguments_ = parseArguments(argv);
  if (arguments_.command === "version" || arguments_.command === "help" || arguments_.command === "invalid") {
    return run(argv);
  }
  const result = arguments_.command.startsWith("events.")
    ? await executeEventsCommand(arguments_, io)
    : arguments_.command.startsWith("workspace.")
      ? await executeWorkspaceCommand(arguments_, io)
      : arguments_.command === "init"
        ? await executeInitCommand(arguments_, io)
        : arguments_.command === "scan"
          ? await executeScanCommand(arguments_)
      : arguments_.command === "doctor"
            ? await executeDoctorCommand(arguments_)
            : arguments_.command === "providers.prefer" || arguments_.command === "providers.trust"
              ? await executeProviderSettingsCommand(arguments_, io)
            : arguments_.command.startsWith("providers.")
              ? await executeProvidersCommand(arguments_)
              : arguments_.command === "route"
                ? await executeRouteCommand(arguments_, io)
                : arguments_.command === "tune"
                  ? await executeTuneCommand(arguments_, io)
                : arguments_.command.startsWith("changes.")
                  ? await executeChangesCommand(arguments_, io)
                  : arguments_.command.startsWith("sessions.")
                    ? await executeSessionsCommand(arguments_, io)
                    : arguments_.command === "history.purge"
                      ? await executeHistoryPurgeCommand(arguments_)
            : await executeEvalCommand(arguments_, io);
  render(result, arguments_.json);
  return result.exitCode;
}

export function isMainModule(moduleUrl: string, entryPath: string | undefined): boolean {
  if (!entryPath) return false;
  try {
    const normalizedModuleUrl = pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href;
    const normalizedEntryUrl = pathToFileURL(realpathSync(resolve(entryPath))).href;
    return normalizedModuleUrl === normalizedEntryUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}

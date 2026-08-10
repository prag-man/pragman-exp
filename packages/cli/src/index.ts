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
import { executeRouteCommand } from "./commands/route.ts";
import { executeChangesCommand } from "./commands/changes.ts";
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

  if (arguments_.json) {
    writeJson(successEnvelope("help", {
      usage: "pragman --version [--json]",
    }));
  } else {
    process.stdout.write("Usage: pragman --version [--json]\n");
  }
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
            : arguments_.command.startsWith("providers.")
              ? await executeProvidersCommand(arguments_)
              : arguments_.command === "route"
                ? await executeRouteCommand(arguments_, io)
                : arguments_.command.startsWith("changes.")
                  ? await executeChangesCommand(arguments_, io)
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

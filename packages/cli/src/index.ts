#!/usr/bin/env node

import { parseArguments } from "./args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "./envelope.ts";
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
  process.exitCode = run(process.argv.slice(2));
}

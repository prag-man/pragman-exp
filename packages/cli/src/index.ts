#!/usr/bin/env node

import { parseArguments } from "./args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "./envelope.ts";

const VERSION = "0.1.0";

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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2));
}

import { homedir } from "node:os";

import { discoverKnownHosts } from "../../../provider-registry/src/discovery.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution } from "./events.ts";

export async function executeScanCommand(arguments_: CliArguments): Promise<CommandExecution> {
  const command = "scan";
  try {
    const report = await discoverKnownHosts({
      homeRoot: homedir(),
      ...(arguments_.projectRoot ? { projectRoot: arguments_.projectRoot } : {}),
    });
    return {
      exitCode: EXIT_CODES.success,
      envelope: successEnvelope(command, report, report.warnings.map((warning) => warning.code)),
      human: `${report.installations.length} installations discovered${report.truncated ? " (bounded result)" : ""}.`,
      stderr: false,
    };
  } catch {
    const message = "Known-host metadata scan could not complete";
    return {
      exitCode: EXIT_CODES.temporary,
      envelope: errorEnvelope(command, "TEMPORARY_FAILURE", message, null, true),
      human: message,
      stderr: true,
    };
  }
}

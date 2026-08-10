export interface CliArguments {
  command: "version" | "help" | "invalid";
  json: boolean;
  invalidArguments: string[];
}

export function parseArguments(argv: readonly string[]): CliArguments {
  let command: CliArguments["command"] | undefined;
  let json = false;
  const invalidArguments: string[] = [];

  for (const argument of argv) {
    if (argument === "--json") {
      json = true;
    } else if (argument === "--version" || argument === "-v") {
      command ??= "version";
    } else if (argument === "--help" || argument === "-h") {
      command ??= "help";
    } else {
      invalidArguments.push(argument);
    }
  }

  if (invalidArguments.length > 0) {
    command = "invalid";
  }

  return { command: command ?? "help", json, invalidArguments };
}

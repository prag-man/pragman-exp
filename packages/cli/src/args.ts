export type CliCommand =
  | "version" | "help" | "invalid"
  | "init" | "scan" | "doctor"
  | "events.record" | "events.score" | "events.list" | "events.summary" | "events.rebuild"
  | "events.export" | "events.purge" | "events.candidates.list" | "events.candidates.decide"
  | "eval.run" | "eval.compare"
  | "tune"
  | "route" | "providers.list" | "providers.inspect" | "providers.prefer" | "providers.trust"
  | "changes.list" | "changes.preview" | "changes.apply" | "changes.rollback" | "history.purge"
  | "sessions.scan" | "sessions.analyze" | "sessions.purge"
  | "workspace.add" | "workspace.edit" | "workspace.list" | "workspace.link" | "workspace.unlink" | "workspace.validate";

export interface CliArguments {
  command: CliCommand;
  json: boolean;
  nonInteractive: boolean;
  file?: string;
  config?: string;
  stateRoot?: string;
  applyDigest?: string;
  preview: boolean;
  acknowledgeTrust: boolean;
  overrideLocalEvents: boolean;
  raw: boolean;
  confirmContentFreeRaw: boolean;
  from?: string;
  through?: string;
  classes: string[];
  runner?: string;
  workspace?: string;
  projectRoot?: string;
  providersDir?: string;
  provider?: string;
  host?: string;
  hostVersion?: string;
  target?: string;
  targetId?: string;
  change?: string;
  invalidArguments: string[];
  helpTarget?: string;
}

const VALUE_OPTIONS = new Map([
  ["--file", "file"], ["--config", "config"], ["--state-root", "stateRoot"],
  ["--apply", "applyDigest"], ["--from", "from"], ["--through", "through"], ["--runner", "runner"],
  ["--workspace", "workspace"], ["--project-root", "projectRoot"],
  ["--providers-dir", "providersDir"], ["--provider", "provider"], ["--host", "host"], ["--host-version", "hostVersion"],
  ["--target", "target"], ["--target-id", "targetId"], ["--change", "change"],
] as const);

function commandFrom(positionals: readonly string[], version: boolean, help: boolean): CliCommand | null {
  if (version) return positionals.length === 0 ? "version" : null;
  const rawKey = positionals.join(".");
  const key = rawKey === "eval" ? "eval.run" : rawKey;
  const commands = new Set<CliCommand>([
    "init", "scan", "doctor", "route", "tune", "providers.list", "providers.inspect", "providers.prefer", "providers.trust",
    "changes.list", "changes.preview", "changes.apply", "changes.rollback", "history.purge",
    "sessions.scan", "sessions.analyze", "sessions.purge",
    "events.record", "events.score", "events.list", "events.summary", "events.rebuild", "events.export",
    "events.purge", "events.candidates.list", "events.candidates.decide", "eval.run", "eval.compare",
    "workspace.add", "workspace.edit", "workspace.list", "workspace.link", "workspace.unlink", "workspace.validate",
  ]);
  if (help) return positionals.length === 0 || commands.has(key as CliCommand) ? "help" : null;
  if (commands.has(key as CliCommand)) return key as CliCommand;
  return positionals.length === 0 ? "help" : null;
}

export function parseArguments(argv: readonly string[]): CliArguments {
  let json = false;
  let nonInteractive = false;
  let preview = false;
  let acknowledgeTrust = false;
  let overrideLocalEvents = false;
  let raw = false;
  let confirmContentFreeRaw = false;
  let version = false;
  let help = false;
  const values: Record<string, string | undefined> = {};
  const classes: string[] = [];
  const positionals: string[] = [];
  const invalidArguments: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") json = true;
    else if (argument === "--non-interactive") nonInteractive = true;
    else if (argument === "--preview") preview = true;
    else if (argument === "--acknowledge-trust" || argument === "--acknowledge") acknowledgeTrust = true;
    else if (argument === "--override-local-events") overrideLocalEvents = true;
    else if (argument === "--raw") raw = true;
    else if (argument === "--confirm-content-free-raw") confirmContentFreeRaw = true;
    else if (argument === "--version" || argument === "-v") version = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--class") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) invalidArguments.push(argument);
      else { classes.push(...value.split(",").filter(Boolean)); index += 1; }
    } else if (VALUE_OPTIONS.has(argument as never)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) invalidArguments.push(argument);
      else { values[VALUE_OPTIONS.get(argument as never)!] = value; index += 1; }
    } else if (argument.startsWith("-")) invalidArguments.push(argument);
    else positionals.push(argument);
  }
  const command = commandFrom(positionals, version, help);
  if (command === null) invalidArguments.push(...positionals);
  const result: CliArguments = {
    command: invalidArguments.length > 0 ? "invalid" : command ?? "help",
    json, nonInteractive, preview, acknowledgeTrust, overrideLocalEvents, raw, confirmContentFreeRaw, classes, invalidArguments,
  };
  if (help && positionals.length > 0 && command === "help") result.helpTarget = positionals.join(" ");
  for (const [key, value] of Object.entries(values)) if (value !== undefined) (result as unknown as Record<string, unknown>)[key] = value;
  return result;
}

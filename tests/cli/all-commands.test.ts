import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseArguments, type CliCommand } from "../../packages/cli/src/args.ts";

const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;

const PUBLIC_COMMANDS: ReadonlyArray<{ argv: string[]; command: CliCommand; helpTarget: string }> = [
  { argv: ["init"], command: "init", helpTarget: "init" },
  { argv: ["scan"], command: "scan", helpTarget: "scan" },
  { argv: ["doctor"], command: "doctor", helpTarget: "doctor" },
  { argv: ["tune"], command: "tune", helpTarget: "tune" },
  { argv: ["route"], command: "route", helpTarget: "route" },
  ...(["add", "edit", "list", "link", "unlink", "validate"] as const).map((action) => ({
    argv: ["workspace", action], command: `workspace.${action}` as CliCommand, helpTarget: `workspace ${action}`,
  })),
  ...(["list", "inspect", "prefer", "trust"] as const).map((action) => ({
    argv: ["providers", action], command: `providers.${action}` as CliCommand, helpTarget: `providers ${action}`,
  })),
  ...(["scan", "analyze", "purge"] as const).map((action) => ({
    argv: ["sessions", action], command: `sessions.${action}` as CliCommand, helpTarget: `sessions ${action}`,
  })),
  ...(["list", "preview", "apply", "rollback"] as const).map((action) => ({
    argv: ["changes", action], command: `changes.${action}` as CliCommand, helpTarget: `changes ${action}`,
  })),
  { argv: ["history", "purge"], command: "history.purge", helpTarget: "history purge" },
  { argv: ["eval"], command: "eval.run", helpTarget: "eval" },
  { argv: ["eval", "run"], command: "eval.run", helpTarget: "eval run" },
  { argv: ["eval", "compare"], command: "eval.compare", helpTarget: "eval compare" },
  ...(["record", "score", "list", "summary", "rebuild", "export", "purge"] as const).map((action) => ({
    argv: ["events", action], command: `events.${action}` as CliCommand, helpTarget: `events ${action}`,
  })),
  { argv: ["events", "candidates", "list"], command: "events.candidates.list", helpTarget: "events candidates list" },
  { argv: ["events", "candidates", "decide"], command: "events.candidates.decide", helpTarget: "events candidates decide" },
];

test("every public command has an unambiguous parser mapping", () => {
  for (const entry of PUBLIC_COMMANDS) {
    const parsed = parseArguments(entry.argv);
    assert.equal(parsed.command, entry.command, entry.argv.join(" "));
    assert.deepEqual(parsed.invalidArguments, [], entry.argv.join(" "));
  }
});

test("every public command exposes help without executing its workflow", () => {
  for (const entry of PUBLIC_COMMANDS) {
    const parsed = parseArguments([...entry.argv, "--help", "--json"]);
    assert.equal(parsed.command, "help", entry.argv.join(" "));
    assert.equal(parsed.helpTarget, entry.helpTarget, entry.argv.join(" "));

    const result = spawnSync(process.execPath, [cli, ...entry.argv, "--help", "--json"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.status, 0, `${entry.argv.join(" ")}: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      data: { command: string; usage: string };
    };
    assert.equal(envelope.ok, true, entry.argv.join(" "));
    assert.equal(envelope.command, "help", entry.argv.join(" "));
    assert.equal(envelope.data.command, entry.helpTarget, entry.argv.join(" "));
    const prefix = `Usage: pragman ${entry.helpTarget} `;
    assert.equal(envelope.data.usage.startsWith(prefix), true, entry.argv.join(" "));
    assert.equal(envelope.data.usage.length > prefix.length, true, entry.argv.join(" "));
  }
});

test("global help lists each public command family and rejects command typos", () => {
  const result = spawnSync(process.execPath, [cli, "--help", "--json"], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  const usage = (JSON.parse(result.stdout) as { data: { usage: string } }).data.usage;
  for (const family of ["init", "scan", "doctor", "route", "tune", "workspace", "providers", "sessions", "changes", "history", "eval", "events"]) {
    assert.match(usage, new RegExp(`\\b${family}\\b`));
  }
  assert.equal(parseArguments(["workspace", "adde", "--help"]).command, "invalid");
});

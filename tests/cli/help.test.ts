import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseArguments } from "../../packages/cli/src/args.ts";

const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;

test("bare eval is the default evaluation run command", () => {
  assert.equal(parseArguments(["eval"]).command, "eval.run");
});

test("command help resolves without executing the command", () => {
  const result = spawnSync(process.execPath, [cli, "sessions", "analyze", "--help", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout) as { ok: boolean; command: string; data: { usage: string; command: string } };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "help");
  assert.equal(envelope.data.command, "sessions analyze");
  assert.match(envelope.data.usage, /pragman sessions analyze/);
});

test("unknown command help fails instead of hiding a typo", () => {
  assert.equal(parseArguments(["unknown", "--help"]).command, "invalid");
});

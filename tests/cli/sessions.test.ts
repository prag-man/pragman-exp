import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../../packages/cli/src/args.ts";

const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;

function invoke(root: string, args: string[], input?: unknown) {
  return spawnSync(process.execPath, [cli, ...args, "--config", root, "--json"], { encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input) });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragman-sessions-cli-"));
  const sessions = join(root, "source");
  await mkdir(sessions);
  await writeFile(join(sessions, "session.jsonl"), [
    { timestamp: "2026-08-10T10:00:00.000Z", type: "session_meta", payload: { id: "demo", version: "1" } },
    { timestamp: "2026-08-10T10:00:01.000Z", type: "response_item", payload: { role: "user", content: "api_key=secret-1234567890 please fix it" } },
    { timestamp: "2026-08-10T10:00:02.000Z", type: "event_msg", payload: { type: "context_compacted" } },
  ].map(JSON.stringify).join("\n"));
  return { root, sessions };
}

function selection(sessions: string) {
  return { sources: [{ adapter: "codex", root: sessions, project_alias: "demo" }], from: "2026-08-01T00:00:00.000Z", through: "2026-08-31T23:59:59.999Z", project_aliases: ["demo"], content_categories: ["messages", "lifecycle"], privacy_depth: "safe" };
}

test("argument grammar recognizes session and history commands", () => {
  for (const action of ["scan", "analyze", "purge"]) assert.equal(parseArguments(["sessions", action]).command, `sessions.${action}`);
  assert.equal(parseArguments(["history", "purge"]).command, "history.purge");
});

test("sessions scan is explicit, bounded, redacted, and path safe", async () => {
  const { root, sessions } = await fixture();
  const result = invoke(root, ["sessions", "scan"], selection(sessions));
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.sessions_parsed, 1);
  assert.equal(data.metrics.compaction_count, 1);
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes(sessions), false);
  assert.equal(serialized.includes("secret-1234567890"), false);
});

test("sessions analyze asks for missing intent/context and never authorizes mutation", async () => {
  const { root, sessions } = await fixture();
  const result = invoke(root, ["sessions", "analyze"], { selection: selection(sessions), context: {} });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.mutation_allowed, false);
  assert.ok(data.questions.length >= 2);
  assert.deepEqual(Object.keys(data.report.actions), ["Keep", "Change", "Stop", "Automate", "Learn", "Test next"]);
  assert.equal(JSON.stringify(data).includes("api_key"), false);
});

test("session and history purge require unchanged previews and delete derived files only", async () => {
  const { root, sessions } = await fixture();
  const derived = join(root, "state", "sessions");
  const snapshots = join(root, "history", "snapshots");
  await mkdir(derived, { recursive: true });
  await mkdir(snapshots, { recursive: true });
  await writeFile(join(derived, "metrics.json"), "{}\n");
  await writeFile(join(snapshots, "digest.bin"), "snapshot");
  for (const [command, expected] of [["sessions", join(derived, "metrics.json")], ["history", join(snapshots, "digest.bin")]] as const) {
    const preview = JSON.parse(invoke(root, [command, "purge"]).stdout).data;
    assert.equal(preview.file_count, 1);
    assert.equal(invoke(root, [command, "purge", "--apply", "0".repeat(64)]).status, 5);
    const applied = invoke(root, [command, "purge", "--apply", preview.preview_digest]);
    assert.equal(applied.status, 0, applied.stderr);
    await assert.rejects(readFile(expected));
  }
  assert.ok(await readFile(join(sessions, "session.jsonl")));
});

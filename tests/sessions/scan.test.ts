import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scanSessions } from "../../packages/session-adapters/src/index.ts";

async function fixtureRoot(t: test.TestContext): Promise<string> {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "pragman-sessions-")));
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  return root;
}

const range = { from: "2026-08-01T00:00:00.000Z", through: "2026-08-31T23:59:59.999Z" };

test("scan requires explicit safe selection and rejects broad or escaping roots", async (t) => {
  const root = await fixtureRoot(t);
  await assert.rejects(
    scanSessions({ sources: [{ adapter: "codex", root: "/", project_alias: "demo" }], ...range, project_aliases: ["demo"], content_categories: ["messages"], privacy_depth: "metadata-only" }),
    (error: unknown) => (error as { code?: string }).code === "UNSAFE_ROOT",
  );
  await assert.rejects(
    scanSessions({ sources: [{ adapter: "codex", root, project_alias: "not-selected" }], ...range, project_aliases: ["demo"], content_categories: ["messages"], privacy_depth: "metadata-only" }),
    (error: unknown) => (error as { code?: string }).code === "PROJECT_NOT_SELECTED",
  );
});

test("scan skips symlinks and files outside the inclusive time selection", async (t) => {
  const root = await fixtureRoot(t);
  const outside = await fixtureRoot(t);
  await writeFile(join(root, "inside.jsonl"), JSON.stringify({ timestamp: "2026-08-10T10:00:00.000Z", type: "session_meta", payload: { id: "inside", version: "1" } }));
  await writeFile(join(root, "old.jsonl"), JSON.stringify({ timestamp: "2026-07-10T10:00:00.000Z", type: "session_meta", payload: { id: "old", version: "1" } }));
  await writeFile(join(outside, "escaped.jsonl"), JSON.stringify({ timestamp: "2026-08-10T10:00:00.000Z", type: "session_meta", payload: { id: "outside", version: "1" } }));
  await symlink(join(outside, "escaped.jsonl"), join(root, "escape.jsonl"));

  const result = await scanSessions({
    sources: [{ adapter: "codex", root, project_alias: "demo" }],
    ...range, project_aliases: ["demo"], content_categories: ["lifecycle"], privacy_depth: "metadata-only",
  });

  assert.equal(result.sessions_selected, 2);
  assert.equal(result.sessions_parsed, 2);
  assert.equal(result.events.length, 1);
  assert.equal(result.warnings.some((entry) => entry.code === "SYMLINK_SKIPPED"), true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(JSON.stringify(result), /inside\.jsonl|old\.jsonl|escaped\.jsonl/);
});

test("scan enforces per-file, run-byte, and event bounds before copying content", async (t) => {
  const root = await fixtureRoot(t);
  await writeFile(join(root, "large.jsonl"), "x".repeat(101));

  const result = await scanSessions({
    sources: [{ adapter: "codex", root, project_alias: "demo" }],
    ...range, project_aliases: ["demo"], content_categories: ["messages"], privacy_depth: "metadata-only",
    limits: { maximum_file_bytes: 100, maximum_run_bytes: 100, maximum_events: 10, maximum_files: 10 },
  });

  assert.equal(result.sessions_selected, 1);
  assert.equal(result.sessions_failed, 1);
  assert.equal(result.report_only, true);
  assert.deepEqual(result.quarantine.map((entry) => entry.code), ["FILE_TOO_LARGE"]);
  assert.doesNotMatch(JSON.stringify(result), /large\.jsonl|xxxxx/);
});

test("more than ten percent failed sessions forces report-only recommendations", async (t) => {
  const root = await fixtureRoot(t);
  for (let index = 0; index < 9; index += 1) {
    await writeFile(join(root, `ok-${index}.jsonl`), JSON.stringify({ timestamp: `2026-08-10T10:00:0${index}.000Z`, type: "session_meta", payload: { id: `s-${index}`, version: "1" } }));
  }
  await writeFile(join(root, "bad.jsonl"), "not-json");

  const result = await scanSessions({
    sources: [{ adapter: "codex", root, project_alias: "demo" }],
    ...range, project_aliases: ["demo"], content_categories: ["lifecycle"], privacy_depth: "metadata-only",
  });

  assert.equal(result.sessions_selected, 10);
  assert.equal(result.sessions_failed, 1);
  assert.equal(result.failure_ratio, 0.1);
  assert.equal(result.report_only, false);

  await writeFile(join(root, "bad-2.jsonl"), "still-not-json");
  const degraded = await scanSessions({
    sources: [{ adapter: "codex", root, project_alias: "demo" }],
    ...range, project_aliases: ["demo"], content_categories: ["lifecycle"], privacy_depth: "metadata-only",
  });
  assert.equal(degraded.failure_ratio > 0.1, true);
  assert.equal(degraded.report_only, true);
  assert.equal(degraded.apply_allowed, false);
});

test("unsupported source formats are isolated while unrelated sources still parse", async (t) => {
  const codexRoot = await fixtureRoot(t);
  const cursorRoot = await fixtureRoot(t);
  await writeFile(join(codexRoot, "good.jsonl"), JSON.stringify({ timestamp: "2026-08-10T10:00:00.000Z", type: "session_meta", payload: { id: "ok", version: "1" } }));
  await mkdir(join(cursorRoot, "nested"));
  await writeFile(join(cursorRoot, "nested", "unsupported.sqlite"), "binary-secret");

  const result = await scanSessions({
    sources: [
      { adapter: "codex", root: codexRoot, project_alias: "demo" },
      { adapter: "cursor-markdown", root: cursorRoot, project_alias: "demo" },
    ],
    ...range, project_aliases: ["demo"], content_categories: ["lifecycle"], privacy_depth: "metadata-only",
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.warnings.some((entry) => entry.code === "UNSUPPORTED_FILE"), true);
  assert.doesNotMatch(JSON.stringify(result), /unsupported\.sqlite|binary-secret/);
});

test("an unreadable selected root does not abort an unrelated healthy source", async (t) => {
  const root = await fixtureRoot(t);
  await writeFile(join(root, "good.jsonl"), JSON.stringify({ timestamp: "2026-08-10T10:00:00.000Z", type: "session_meta", payload: { id: "ok", version: "1" } }));
  const result = await scanSessions({
    sources: [
      { adapter: "codex", root, project_alias: "demo" },
      { adapter: "claude-code", root: join(root, "missing"), project_alias: "demo" },
    ],
    ...range, project_aliases: ["demo"], content_categories: ["lifecycle"], privacy_depth: "metadata-only",
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.warnings.some((entry) => entry.code === "SOURCE_UNREADABLE"), true);
  assert.doesNotMatch(JSON.stringify(result), /missing/);
});

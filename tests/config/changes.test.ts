import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ConfigError, applyChange, previewChange, rollbackChange } from "../../packages/config/src/index.ts";

const makeTempDirectory = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

test("previews and atomically applies a constrained patch with an exact snapshot", async () => {
  const root = await makeTempDirectory("pragman-changes-");
  const target = join(root, "config.json");
  const original = Buffer.from('{"schema_version":1,"name":"before","items":["a"]}\n');
  await writeFile(target, original);

  const preview = await previewChange({
    stateRoot: root,
    targetPath: target,
    target: "personal",
    targetId: "local",
    operations: [
      { op: "replace", path: "/name", value: "after" },
      { op: "add", path: "/items/-", value: "b" },
    ],
    reason: "Update preferences",
  });
  assert.equal((await readFile(target)).equals(original), true);

  const applied = await applyChange(preview, preview.preview_digest);
  assert.equal(JSON.parse(await readFile(target, "utf8")).name, "after");
  assert.ok(applied.record.applied_at);
  assert.equal((await readFile(applied.snapshotPath)).equals(original), true);
  assert.match(await readFile(join(root, "history", "changes.jsonl"), "utf8"), new RegExp(preview.change_id));
});

test("denies stale previews, wrong preview digests, and a second writer", async () => {
  const root = await makeTempDirectory("pragman-changes-stale-");
  const target = join(root, "config.json");
  await writeFile(target, '{"schema_version":1,"name":"before"}\n');
  const preview = await previewChange({
    stateRoot: root,
    targetPath: target,
    target: "personal",
    targetId: "local",
    operations: [{ op: "replace", path: "/name", value: "after" }],
    reason: "Update",
  });
  await assert.rejects(applyChange(preview, "0".repeat(64)), (error) => error instanceof ConfigError && error.code === "STALE_PREVIEW");
  await writeFile(target, '{"schema_version":1,"name":"someone-else"}\n');
  await assert.rejects(applyChange(preview, preview.preview_digest), (error) => error instanceof ConfigError && error.code === "STALE_PREVIEW");

  await mkdir(join(root, ".change-lock"));
  await assert.rejects(applyChange(await previewChange({
    stateRoot: root,
    targetPath: target,
    target: "personal",
    targetId: "local",
    operations: [{ op: "replace", path: "/name", value: "new" }],
    reason: "Update",
  }), undefined), (error) => error instanceof ConfigError && error.code === "TEMPORARY_FAILURE");
});

test("rollback restores exact bytes atomically, rejects drift, and appends audit history", async () => {
  const root = await makeTempDirectory("pragman-rollback-");
  const target = join(root, "config.json");
  const original = Buffer.from('{ "schema_version": 1, "name": "before" }\n');
  await writeFile(target, original);
  const preview = await previewChange({
    stateRoot: root,
    targetPath: target,
    target: "personal",
    targetId: "local",
    operations: [{ op: "replace", path: "/name", value: "after" }],
    reason: "Update",
  });
  const applied = await applyChange(preview, preview.preview_digest);
  const rolledBack = await rollbackChange(applied.record, { stateRoot: root, targetPath: target });
  assert.equal((await readFile(target)).equals(original), true);
  assert.notEqual(rolledBack.record.change_id, applied.record.change_id);
  const lines = (await readFile(join(root, "history", "changes.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);

  const second = await previewChange({
    stateRoot: root,
    targetPath: target,
    target: "personal",
    targetId: "local",
    operations: [{ op: "replace", path: "/name", value: "again" }],
    reason: "Again",
  });
  const secondApplied = await applyChange(second, second.preview_digest);
  await writeFile(target, "drift\n");
  await assert.rejects(
    rollbackChange(secondApplied.record, { stateRoot: root, targetPath: target }),
    (error) => error instanceof ConfigError && error.code === "STALE_PREVIEW",
  );
});

test("rejects unsafe or invalid patch operations before writing", async () => {
  const root = await makeTempDirectory("pragman-patch-invalid-");
  const target = join(root, "config.json");
  await writeFile(target, '{"schema_version":1,"name":"before"}\n');
  await assert.rejects(
    previewChange({
      stateRoot: root,
      targetPath: target,
      target: "personal",
      targetId: "local",
      operations: [{ op: "replace", path: "/__proto__/polluted", value: true }],
      reason: "Unsafe",
    }),
    (error) => error instanceof ConfigError && error.code === "INVALID_PATCH",
  );
});

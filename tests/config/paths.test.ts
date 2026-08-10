import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigError, normalizeAbsolutePath, resolveContainedPath, workspaceConfigPath } from "../../packages/config/src/index.ts";

const makeTempDirectory = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

test("normalizes absolute paths and builds contained workspace paths", async () => {
  const root = await makeTempDirectory("pragman-config-path-");
  assert.equal(normalizeAbsolutePath(`${root}/nested/..`), root);
  assert.equal(workspaceConfigPath(root, "client-a"), join(root, "workspaces", "client-a", "workspace.yaml"));
  assert.throws(() => workspaceConfigPath(root, "../escape"), (error) => error instanceof ConfigError && error.code === "INVALID_PATH");
});

test("rejects traversal and symlinks escaping the selected root", async () => {
  const root = await makeTempDirectory("pragman-config-contained-");
  const outside = await makeTempDirectory("pragman-config-outside-");
  await mkdir(join(root, "context"));
  await symlink(outside, join(root, "context", "escape"));

  assert.throws(() => resolveContainedPath(root, "../secret"), (error) => error instanceof ConfigError && error.code === "INVALID_PATH");
  await assert.rejects(
    resolveContainedPath(root, "context/escape", { verifyRealPath: true }),
    (error) => error instanceof ConfigError && error.code === "INVALID_PATH",
  );
  assert.throws(() => normalizeAbsolutePath(`${tmpdir()}/x/..`, { requireNormalized: true }), /not normalized/i);
});

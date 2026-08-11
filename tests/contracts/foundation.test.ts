import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("package targets supported Node releases and exposes the pragman binary", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

  assert.equal(packageJson.name, "@prag-man/pragman-exp");
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.engines.node, ">=22 <25");
  assert.equal(packageJson.bin.pragman, "dist/packages/cli/src/index.js");
});

test("normative ID rules document the provider and repository-source exceptions", async () => {
  const design = await readFile(
    new URL("docs/superpowers/specs/2026-08-10-pragman-exp-design.md", root),
    "utf8",
  );

  assert.match(design, /Provider IDs are `<namespace>:<slug>`/);
  assert.match(design, /repository sources are `<owner>\/<repo>`/);
});

test("pragman --version --json returns the stable automation envelope", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const result = spawnSync(
    process.execPath,
    [new URL("packages/cli/src/index.ts", root).pathname, "--version", "--json"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), [
    "ok",
    "command",
    "schema_version",
    "data",
    "warnings",
    "error",
  ]);
  assert.equal(output.ok, true);
  assert.equal(output.command, "version");
  assert.equal(output.schema_version, 1);
  assert.equal(output.data.version, packageJson.version);
  assert.deepEqual(output.warnings, []);
  assert.equal(output.error, null);
});

test("unknown CLI arguments use the invalid-input exit class and JSON error", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("packages/cli/src/index.ts", root).pathname, "--unknown", "--json"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 2, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.data, null);
  assert.equal(output.error.code, "INVALID_INPUT");
  assert.equal(output.error.retryable, false);
});

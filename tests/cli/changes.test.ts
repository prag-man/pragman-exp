import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "pragman-changes-"));
  await writeFile(join(root, "config.yaml"), "schema_version: 1\nprivacy:\n  default_sensitivity: internal\nupdates:\n  channel: stable\noutput:\n  format: human\n");
  return root;
}

const change = { target: "personal", target_id: "personal", operations: [{ op: "replace", path: "/output/format", value: "json" }], reason: "Prefer automation output", evidence_refs: ["decision:output"] };

test("argument grammar recognizes all change commands", () => {
  for (const action of ["list", "preview", "apply", "rollback"]) assert.equal(parseArguments(["changes", action]).command, `changes.${action}`);
  const parsed = parseArguments(["changes", "rollback", "--change", "01900000-0000-7000-8000-000000000000", "--target", "personal", "--target-id", "personal"]);
  assert.equal(parsed.change, "01900000-0000-7000-8000-000000000000");
});

test("generic changes preview, apply, list, and rollback with digest-bound approval", async () => {
  const root = await fixture();
  const previewResult = invoke(root, ["changes", "preview"], change);
  assert.equal(previewResult.status, 0, previewResult.stderr);
  const preview = JSON.parse(previewResult.stdout).data;
  assert.equal(preview.mutated, false);
  assert.equal("targetPath" in preview, false);
  const stale = invoke(root, ["changes", "apply", "--apply", "0".repeat(64)], change);
  assert.equal(stale.status, 5);
  const appliedResult = invoke(root, ["changes", "apply", "--apply", preview.preview_digest], change);
  assert.equal(appliedResult.status, 0, appliedResult.stderr);
  assert.match(await readFile(join(root, "config.yaml"), "utf8"), /format: json/);
  const changes = JSON.parse(invoke(root, ["changes", "list"]).stdout).data.changes;
  assert.equal(changes.length, 1);
  const rollbackPreview = JSON.parse(invoke(root, ["changes", "rollback", "--change", changes[0].change_id]).stdout).data;
  assert.equal(rollbackPreview.mutated, false);
  const rollback = invoke(root, ["changes", "rollback", "--change", changes[0].change_id, "--apply", rollbackPreview.preview_digest]);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.match(await readFile(join(root, "config.yaml"), "utf8"), /format: human/);
});

test("changes reject missing approval, invalid patch fields, and stale rollback targets", async () => {
  const root = await fixture();
  const noApproval = invoke(root, ["changes", "apply"], change);
  assert.equal(noApproval.status, 3);
  const invalid = invoke(root, ["changes", "preview"], { ...change, operations: [{ op: "copy", path: "/output/format", value: "json" }] });
  assert.equal(invalid.status, 2);
  const preview = JSON.parse(invoke(root, ["changes", "preview"], change).stdout).data;
  invoke(root, ["changes", "apply", "--apply", preview.preview_digest], change);
  const [applied] = JSON.parse(invoke(root, ["changes", "list"]).stdout).data.changes;
  await writeFile(join(root, "config.yaml"), "schema_version: 1\nprivacy:\n  default_sensitivity: public\nupdates:\n  channel: stable\noutput:\n  format: json\n");
  const rollbackPreview = JSON.parse(invoke(root, ["changes", "rollback", "--change", applied.change_id]).stdout).data;
  const rollback = invoke(root, ["changes", "rollback", "--change", applied.change_id, "--apply", rollbackPreview.preview_digest]);
  assert.equal(rollback.status, 5);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const validator = new URL("../../scripts/validate-skills.mjs", import.meta.url).pathname;

test("the public corpus contains exactly eight portable validated skills", () => {
  const result = spawnSync(process.execPath, [validator], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.skills.map((skill: { name: string }) => skill.name), [
    "pragman-analyze", "pragman-init", "pragman-prototype", "pragman-research",
    "pragman-router", "pragman-shape", "pragman-unfck", "pragman-workspace",
  ]);
  assert.equal(report.skills.every((skill: { scenarios: number; lines: number }) => skill.scenarios >= 3 && skill.lines <= 500), true);
});

import assert from "node:assert/strict";
import test from "node:test";

test("test runner resolves directory arguments to a deterministic focused file list", async () => {
  const { resolveTestFiles } = await import("../../scripts/run-tests.mjs");
  const files = await resolveTestFiles(["tests/redaction"]);

  assert.deepEqual(files, ["tests/redaction/redaction.test.ts"]);
});


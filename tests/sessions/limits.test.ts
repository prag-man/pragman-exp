import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SESSION_LIMITS, resolveSessionLimits, validateSessionSelection } from "../../packages/session-adapters/src/index.ts";

test("session limits use conservative documented defaults", () => {
  assert.deepEqual(DEFAULT_SESSION_LIMITS, {
    maximum_file_bytes: 50 * 1024 * 1024,
    maximum_run_bytes: 500 * 1024 * 1024,
    maximum_events: 250_000,
    maximum_files: 10_000,
    maximum_excerpt_characters: 2_048,
    maximum_excerpts: 8,
  });
});

test("v1 never accepts self-asserted raised session limits", () => {
  assert.throws(
    () => resolveSessionLimits({ maximum_file_bytes: DEFAULT_SESSION_LIMITS.maximum_file_bytes + 1 }),
    (error: unknown) => (error as { code?: string }).code === "LIMIT_OVERRIDE_UNSUPPORTED",
  );
  assert.throws(
    () => resolveSessionLimits({ maximum_file_bytes: DEFAULT_SESSION_LIMITS.maximum_file_bytes + 1 }),
    (error: unknown) => (error as { code?: string }).code === "LIMIT_OVERRIDE_UNSUPPORTED",
  );
});

test("selection requires source, UTC time range, project, categories, and privacy depth", () => {
  assert.throws(
    () => validateSessionSelection({ sources: [], from: "bad", through: "bad", project_aliases: [], content_categories: [], privacy_depth: "metadata-only" }),
    (error: unknown) => (error as { code?: string }).code === "INVALID_SELECTION",
  );
});

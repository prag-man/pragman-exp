import assert from "node:assert/strict";
import test from "node:test";

test("envelope helpers emit one stable success and error shape", async () => {
  const { errorEnvelope, successEnvelope } = await import("../../packages/cli/src/envelope.ts");

  assert.deepEqual(successEnvelope("route", { route_id: "route-1" }), {
    ok: true,
    command: "route",
    schema_version: 1,
    data: { route_id: "route-1" },
    warnings: [],
    error: null,
  });
  assert.deepEqual(errorEnvelope("route", "NEEDS_INPUT", "Workspace is required", {
    fields: ["workspace"],
  }), {
    ok: false,
    command: "route",
    schema_version: 1,
    data: null,
    warnings: [],
    error: {
      code: "NEEDS_INPUT",
      message: "Workspace is required",
      details: { fields: ["workspace"] },
      retryable: false,
    },
  });
});

test("exit classes are fixed by the automation contract", async () => {
  const { EXIT_CODES } = await import("../../packages/cli/src/envelope.ts");

  assert.deepEqual(EXIT_CODES, {
    success: 0,
    invalid: 2,
    needsInput: 3,
    unavailable: 4,
    denied: 5,
    temporary: 6,
    internal: 10,
  });
});


import assert from "node:assert/strict";
import test from "node:test";

import { createEventValidators } from "../../packages/events/src/index.ts";
import { routeLifecycleEvents } from "../../packages/cli/src/commands/route-observation.ts";

test("successful routes emit a content-free valid invoked/completed lifecycle pair", () => {
  const [invoked, completed] = routeLifecycleEvents({
    routeId: "01925b8c-7f2d-7a51-a9c0-1d4cb73b10ab", invocationId: "01935b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    host: "codex", hostVersion: "1.2.0", provider: "pragman:shape", status: "succeeded",
    startedAt: new Date("2026-08-10T10:00:00.000Z"), finishedAt: new Date("2026-08-10T10:00:00.025Z"),
  });
  const validators = createEventValidators();
  assert.equal(validators.event(invoked).ok, true);
  assert.equal(validators.event(completed).ok, true);
  assert.equal(invoked.event_type, "invoked");
  assert.equal(completed.event_type, "completed");
  assert.equal(completed.duration_ms, 25);
  const serialized = JSON.stringify([invoked, completed]);
  for (const key of ["request", "prompt", "output", "response", "transcript", "path"]) assert.equal(serialized.includes(`\"${key}\"`), false);
});

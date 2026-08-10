import assert from "node:assert/strict";
import test from "node:test";

import { mergeConfiguration } from "../../packages/config/src/merge.ts";

test("resolves the primary chain field by field and preserves provenance", () => {
  const result = mergeConfiguration({
    defaults: { lane: "fast", output: { format: "human", color: "auto" }, tags: ["default"] },
    personal: { lane: "standard", output: { color: "never" }, tags: ["personal"] },
    primaryWorkspace: { output: { format: "json" } },
    project: { lane: "deep" },
    explicit: { output: { color: "always" } },
  });

  assert.deepEqual(result.value, {
    lane: "deep",
    output: { format: "json", color: "always" },
    tags: ["personal"],
  });
  assert.equal(result.provenance["/lane"]?.layer, "project");
  assert.equal(result.provenance["/output/format"]?.layer, "primary-workspace");
  assert.equal(result.provenance["/output/color"]?.layer, "explicit");
  assert.equal(result.provenance["/tags"]?.layer, "personal");
});

test("ordered sets deduplicate by canonical id while safety prohibitions accumulate", () => {
  const result = mergeConfiguration({
    defaults: { prohibitions: ["delete-prod"], context_sources: [{ id: "base", uri: "a" }] },
    personal: { prohibitions: ["send-secrets"], context_sources: [{ id: "base", uri: "personal" }, { id: "personal", uri: "p" }] },
    primaryWorkspace: { prohibitions: ["force-push"], context_sources: [{ id: "workspace", uri: "w" }] },
    project: { context_sources: [{ id: "project", uri: "x" }] },
    explicit: { prohibitions: [] },
  });

  assert.deepEqual(result.value.prohibitions, ["force-push", "send-secrets", "delete-prod"]);
  assert.deepEqual(
    (result.value.context_sources as Array<{ id: string }>).map((entry) => entry.id),
    ["project", "workspace", "base", "personal"],
  );
  assert.deepEqual((result.provenance["/context_sources"]?.contributors ?? []).map((entry) => entry.layer), [
    "project",
    "primary-workspace",
    "personal",
    "defaults",
  ]);
});

test("additional workspaces append context in explicit order and surface scalar conflicts", () => {
  const result = mergeConfiguration({
    defaults: { lane: "fast" },
    primaryWorkspace: { lane: "standard", context_sources: [{ id: "primary", uri: "p" }] },
    additionalWorkspaces: [
      { workspaceId: "client-a", value: { lane: "deep", region: "india", context_sources: [{ id: "shared", uri: "a" }] } },
      { workspaceId: "client-b", value: { lane: "operational", region: "europe", context_sources: [{ id: "shared", uri: "b" }, { id: "b", uri: "b" }] } },
    ],
  });

  assert.equal(result.value.lane, "standard");
  assert.equal(result.value.region, undefined);
  assert.deepEqual(
    (result.value.context_sources as Array<{ id: string }>).map((entry) => entry.id),
    ["primary", "shared", "b"],
  );
  assert.deepEqual(result.additionalWorkspaceConflicts.map((conflict) => conflict.path).sort(), ["/lane", "/region"]);
  const region = result.additionalWorkspaceConflicts.find((conflict) => conflict.path === "/region");
  assert.deepEqual(region?.values.map((entry) => entry.workspaceId), ["client-a", "client-b"]);
});

test("routing rules sort by layer, priority, and id while additional rules remain advisory", () => {
  const result = mergeConfiguration({
    defaults: { rules: [{ id: "z", priority: 100 }] },
    personal: { rules: [{ id: "b", priority: 1 }, { id: "a", priority: 3 }] },
    primaryWorkspace: { rules: [{ id: "workspace", priority: -1 }] },
    project: { rules: [{ id: "project", priority: 0 }] },
    additionalWorkspaces: [{ workspaceId: "client", value: { rules: [{ id: "candidate", priority: 999 }] } }],
  });

  assert.deepEqual(result.routingRules.map((rule) => rule.rule.id), ["project", "workspace", "a", "b", "z"]);
  assert.equal(result.additionalRoutingCandidates[0]?.workspaceId, "client");
  assert.equal(result.additionalRoutingCandidates[0]?.advisory, true);
});

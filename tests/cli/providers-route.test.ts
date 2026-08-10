import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseArguments } from "../../packages/cli/src/args.ts";

const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;
const providers = new URL("../../providers/", import.meta.url).pathname;

function invoke(arguments_: string[], input?: unknown) {
  return spawnSync(process.execPath, [cli, ...arguments_, "--providers-dir", providers, "--json"], { encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input) });
}

function routeInput(capability = "shape-task") {
  return {
    request: "Shape the smallest useful experiment", task_family: "shape", desired_outcome: "A bounded experiment",
    deliverable_kind: "response-only", execution_mode: "serial", declared_side_effects: [], data_inputs: [], egress_destinations: [], urgency: "normal",
    uncertainties: [{ id: "scope", description: "The smallest useful slice is unknown", impact: "medium" }], scope_systems: ["product"],
    estimated_sessions: "one", downstream_impact: "low", reversibility: "reversible", requested_capabilities: [capability], workspace: null, project: null,
  };
}

test("argument grammar recognizes provider inspection and route selectors", () => {
  assert.equal(parseArguments(["providers", "list"]).command, "providers.list");
  const inspect = parseArguments(["providers", "inspect", "--provider", "pragman:shape", "--host", "claude-code", "--host-version", "1.2.0"]);
  assert.equal(inspect.command, "providers.inspect");
  assert.equal(inspect.provider, "pragman:shape");
  assert.equal(inspect.host, "claude-code");
  assert.equal(parseArguments(["route"]).command, "route");
});

test("providers list and inspect expose capability/status without paths or digests", () => {
  const listed = invoke(["providers", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  const listData = JSON.parse(listed.stdout).data;
  assert.equal(listData.providers.length, 15);
  assert.equal(JSON.stringify(listData).includes("path_alias"), false);
  assert.equal(JSON.stringify(listData).includes("selected_digest"), false);
  const inspected = invoke(["providers", "inspect", "--provider", "pragman:shape"]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).data.id, "pragman:shape");
});

test("route produces an explainable immutable contract through the bundled provider", () => {
  const routed = invoke(["route", "--host", "codex"], routeInput());
  assert.equal(routed.status, 0, routed.stderr);
  const data = JSON.parse(routed.stdout).data;
  assert.equal(data.status, "ready");
  assert.deepEqual(data.contract.providers, ["pragman:shape"]);
  assert.equal(data.contract.request_digest.includes("Shape the"), false);
  assert.ok(data.explanation.laneReasons.length > 0);
  assert.equal(JSON.stringify(data).includes("path_alias"), false);
});

test("route fails closed for missing/unknown input and missing external capability", () => {
  const missing = invoke(["route"]);
  assert.equal(missing.status, 3);
  assert.equal(JSON.parse(missing.stdout).error.code, "NEEDS_INPUT");
  const unknown = invoke(["route"], routeInput("unknown-capability"));
  assert.equal(unknown.status, 5);
  assert.equal(JSON.parse(unknown.stdout).error.code, "UNKNOWN_CAPABILITY");
  const external = invoke(["route"], routeInput("diagnose-software-failure"));
  assert.equal(external.status, 3);
  assert.equal(JSON.parse(external.stdout).error.code, "MISSING_PROVIDER");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../../packages/cli/src/args.ts";

const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;
const providers = new URL("../../providers/", import.meta.url).pathname;

async function homeWith(...skills: string[]) {
  const home = await mkdtemp(join(tmpdir(), "pragman-provider-route-"));
  for (const name of skills) {
    const directory = join(home, ".agents", "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Use when routing this work\n---\n\n# ${name}\n`);
  }
  return home;
}

function invoke(home: string, arguments_: string[], input?: unknown) {
  return spawnSync(process.execPath, [cli, ...arguments_, "--json"], {
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
    env: { ...process.env, HOME: home, USERPROFILE: home, PRAGMAN_TEST_PROVIDERS_DIR: providers },
  });
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
  assert.equal(parseArguments(["route", "--providers-dir", providers]).command, "invalid");
});

test("providers list and inspect expose capability/status without paths or digests", async () => {
  const home = await homeWith();
  const listed = invoke(home, ["providers", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  const listData = JSON.parse(listed.stdout).data;
  assert.equal(listData.providers.length, 15);
  assert.equal(JSON.stringify(listData).includes("path_alias"), false);
  assert.equal(JSON.stringify(listData).includes("selected_digest"), false);
  const inspected = invoke(home, ["providers", "inspect", "--provider", "pragman:shape"]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).data.id, "pragman:shape");
});

test("route produces an explainable immutable contract through a discovered bundled provider", async () => {
  const home = await homeWith("pragman-shape");
  const routed = invoke(home, ["route", "--host", "codex"], routeInput());
  assert.equal(routed.status, 0, routed.stderr);
  const data = JSON.parse(routed.stdout).data;
  assert.equal(data.status, "ready");
  assert.deepEqual(data.contract.providers, ["pragman:shape"]);
  assert.equal(data.contract.request_digest.includes("Shape the"), false);
  assert.ok(data.explanation.laneReasons.length > 0);
  assert.equal(JSON.stringify(data).includes("path_alias"), false);
});

test("route fails closed for missing/unknown input and missing external capability", async () => {
  const home = await homeWith();
  const missing = invoke(home, ["route"]);
  assert.equal(missing.status, 3);
  assert.equal(JSON.parse(missing.stdout).error.code, "NEEDS_INPUT");
  const unknown = invoke(home, ["route"], routeInput("unknown-capability"));
  assert.equal(unknown.status, 5);
  assert.equal(JSON.parse(unknown.stdout).error.code, "UNKNOWN_CAPABILITY");
  const external = invoke(home, ["route"], routeInput("diagnose-software-failure"));
  assert.equal(external.status, 3);
  assert.equal(JSON.parse(external.stdout).error.code, "MISSING_PROVIDER");
});

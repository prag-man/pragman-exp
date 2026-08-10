import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;

function routeInput(context: { workspace?: string | null; project?: string | null } = {}) {
  return {
    request: "Shape the smallest useful experiment", task_family: "shape", desired_outcome: "A bounded experiment",
    deliverable_kind: "response-only", execution_mode: "serial", declared_side_effects: [], data_inputs: [], egress_destinations: [], urgency: "normal",
    uncertainties: [{ id: "scope", description: "The smallest useful slice is unknown", impact: "medium" }], scope_systems: ["product"],
    estimated_sessions: "one", downstream_impact: "low", reversibility: "reversible", requested_capabilities: ["shape-task"],
    workspace: context.workspace ?? null, project: context.project ?? null,
  };
}

function invoke(arguments_: string[], input: unknown, providers: string) {
  return spawnSync(process.execPath, [cli, ...arguments_, "--json"], {
    encoding: "utf8",
    input: JSON.stringify(input),
    env: { ...process.env, PRAGMAN_TEST_PROVIDERS_DIR: providers },
  });
}

async function writeYaml(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

async function providerDirectory(root: string): Promise<string> {
  const directory = join(root, "providers");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "capabilities.yaml"), `schema_version: 1
capabilities:
  - schema_version: 1
    id: shape-task
    stage: 10
    depends_on: []
    result_contract: provider-result-v1
`);
  await writeFile(join(directory, "pragman.yaml"), `schema_version: 1
providers:
  - &base
    schema_version: 1
    id: pragman:alpha
    source: prag-man/pragman-exp
    source_version: 0.1.0
    trust: bundled
    capabilities: [shape-task]
    host_support: [codex, claude-code, cursor]
    invoke: { kind: cli, executable: pragman, arguments: [alpha] }
    context_policy:
      accepted_classes: [task-contract, context-summary]
      maximum_sensitivity: restricted
      accepts_redacted_excerpts: true
    side_effects: []
    workflow_weight: light
    result_contract: provider-result-v1
  - <<: *base
    id: pragman:beta
    invoke: { kind: cli, executable: pragman, arguments: [beta] }
`);
  return directory;
}

const personal = `schema_version: 1
privacy:
  default_sensitivity: internal
updates:
  channel: stable
output:
  format: json
`;

function workspace(id: string, root: string, sensitivity = "internal"): string {
  return `schema_version: 1
workspace_id: ${id}
name: ${id}
root: ${root}
context_sources:
  - id: ${id}-policy
    kind: file
    uri: context/company.md
    description: Company context
    sensitivity: ${sensitivity}
sensitivity: ${sensitivity}
`;
}

test("workspace routing preferences affect provider selection and expose content-free context evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-route-context-"));
  const config = join(root, "config");
  const workspaceRoot = join(root, "company");
  const providers = await providerDirectory(root);
  await mkdir(workspaceRoot, { recursive: true });
  await writeYaml(join(config, "config.yaml"), personal);
  await writeYaml(join(config, "workspaces", "company", "workspace.yaml"), workspace("company", workspaceRoot, "confidential"));
  await writeYaml(join(workspaceRoot, "routing.yaml"), `schema_version: 1
defaults:
  lane: adaptive
  providers: [pragman:beta]
rules: []
`);

  const routed = invoke(["route", "--config", config, "--workspace", "company"], routeInput({ workspace: "company" }), providers);
  assert.equal(routed.status, 0, `${routed.stderr}\n${routed.stdout}`);
  const data = JSON.parse(routed.stdout).data;
  assert.deepEqual(data.contract.providers, ["pragman:beta"]);
  assert.equal(data.contextMode, "workspace-only");
  assert.equal(data.context_policy_evidence.source_bodies_loaded, false);
  assert.deepEqual(data.context_policy_evidence.sources, [
    { source_alias: "context-source:company-policy", sensitivity: "confidential" },
  ]);
  assert.equal(data.context_policy_evidence.provenance.layer, "primary-workspace");
  assert.equal(data.contract.data_inputs[0].source_alias, "context-source:company-policy");
  assert.equal(routed.stdout.includes(workspaceRoot), false);
  assert.equal(routed.stdout.includes("context/company.md"), false);
});

test("project-linked routes block on conflicting additional workspace facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-route-conflict-"));
  const config = join(root, "config");
  const projectRoot = join(root, "project");
  const providers = await providerDirectory(root);
  await writeYaml(join(config, "config.yaml"), personal);
  await mkdir(projectRoot, { recursive: true });
  for (const [id, sensitivity] of [["primary", "internal"], ["client-a", "internal"], ["client-b", "confidential"]] as const) {
    const workspaceRoot = join(root, id);
    await mkdir(workspaceRoot, { recursive: true });
    await writeYaml(join(config, "workspaces", id, "workspace.yaml"), workspace(id, workspaceRoot, sensitivity));
  }
  await writeYaml(join(projectRoot, ".pragman", "manifest.yaml"), `schema_version: 1
project_id: demo
workspace: primary
root: ${projectRoot}
additional_workspaces: [client-a, client-b]
`);

  const routed = invoke(["route", "--config", config, "--project-root", projectRoot], routeInput({ project: "demo" }), providers);
  assert.equal(routed.status, 3, routed.stderr);
  const error = JSON.parse(routed.stdout).error;
  assert.equal(error.code, "NEEDS_INPUT");
  assert.equal(error.details.contextMode, "project-linked");
  assert.equal(error.details.requiredInput, "resolve-secondary-workspace-conflict:/sensitivity");
});

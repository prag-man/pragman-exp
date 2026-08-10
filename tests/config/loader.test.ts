import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ConfigError, loadConfigurationContext } from "../../packages/config/src/index.ts";

const makeTempDirectory = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

async function writeYaml(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

const personal = `schema_version: 1
privacy:
  default_sensitivity: internal
updates:
  channel: stable
output:
  format: human
`;

function workspace(id: string, root: string, source = id): string {
  return `schema_version: 1
workspace_id: ${id}
name: ${id}
root: ${root}
context_sources:
  - id: ${source}
    kind: file
    uri: context/company.md
    description: Company context
    sensitivity: internal
`;
}

test("loads personal-only and workspace-only contexts", async () => {
  const personalRoot = await makeTempDirectory("pragman-loader-personal-");
  await writeYaml(join(personalRoot, "config.yaml"), personal);

  const onlyPersonal = await loadConfigurationContext({ personalRoot });
  assert.equal(onlyPersonal.mode, "personal-only");
  assert.equal(onlyPersonal.personal.output.format, "human");

  const workspaceRoot = join(personalRoot, "company");
  await mkdir(workspaceRoot);
  await writeYaml(join(personalRoot, "workspaces", "company", "workspace.yaml"), workspace("company", workspaceRoot));
  const workspaceOnly = await loadConfigurationContext({ personalRoot, workspaceId: "company" });
  assert.equal(workspaceOnly.mode, "workspace-only");
  assert.equal(workspaceOnly.primaryWorkspace?.workspace_id, "company");
});

test("loads a linked project, infers the primary, and preserves ordered secondary workspaces", async () => {
  const personalRoot = await makeTempDirectory("pragman-loader-linked-");
  const projectRoot = join(personalRoot, "project");
  await mkdir(projectRoot);
  await writeYaml(join(personalRoot, "config.yaml"), personal);
  for (const id of ["primary", "second", "third"]) {
    const root = join(personalRoot, id);
    await mkdir(root);
    await writeYaml(join(personalRoot, "workspaces", id, "workspace.yaml"), workspace(id, root));
  }
  await writeYaml(join(projectRoot, ".pragman", "manifest.yaml"), `schema_version: 1
project_id: demo
workspace: primary
root: ${projectRoot}
additional_workspaces: [third, second]
`);

  const result = await loadConfigurationContext({ personalRoot, projectRoot });
  assert.equal(result.mode, "project-linked");
  assert.equal(result.primaryWorkspace?.workspace_id, "primary");
  assert.deepEqual(result.additionalWorkspaces.map((entry) => entry.workspace_id), ["third", "second"]);
  await assert.rejects(
    loadConfigurationContext({ personalRoot, projectRoot, workspaceId: "second" }),
    (error) => error instanceof ConfigError && error.code === "WORKSPACE_MISMATCH",
  );
});

test("rejects unknown fields, newer schemas, root mismatches, and escaping context indexes", async () => {
  const personalRoot = await makeTempDirectory("pragman-loader-invalid-");
  await writeYaml(join(personalRoot, "config.yaml"), `${personal}unknown: true\n`);
  await assert.rejects(loadConfigurationContext({ personalRoot }), (error) => error instanceof ConfigError && error.code === "INVALID_CONFIGURATION");

  await writeYaml(join(personalRoot, "config.yaml"), personal.replace("schema_version: 1", "schema_version: 2"));
  await assert.rejects(loadConfigurationContext({ personalRoot }), (error) => error instanceof ConfigError && error.code === "INCOMPATIBLE_VERSION");

  await writeYaml(join(personalRoot, "config.yaml"), personal);
  const projectRoot = join(personalRoot, "project");
  await mkdir(projectRoot);
  await writeYaml(join(projectRoot, ".pragman", "manifest.yaml"), `schema_version: 1
project_id: demo
workspace: missing
root: ${personalRoot}
context_index: ../outside.yaml
`);
  await assert.rejects(loadConfigurationContext({ personalRoot, projectRoot }), (error) => error instanceof ConfigError && error.code === "INVALID_CONFIGURATION");
});
